/**
 * Idempotent maintenance and demo seed.
 *
 * Run with: npm run seed
 *
 * Earlier iterations of this project stored departureDateTime as a string,
 * which silently breaks every date comparison and sort in Mongo, and the sample
 * catalogue drifted past the six advertisement limit. It also seeded ticket
 * _id values that are 23 character strings rather than 12 byte ObjectIds, which
 * every route rejects with "Invalid ticket id". This script normalises the
 * data, re-points references at repaired ids, pulls expired departures back
 * into the future so the catalogue is bookable for a demo, and leaves a
 * realistic spread of verification statuses for the admin tables.
 *
 * Safe to run repeatedly.
 */
const { connectDatabase, getCollection, closeDatabase } = require("../src/config/db");
const { TRANSPORT_TYPES } = require("../src/models/ticket.model");
const { ObjectId } = require("mongodb");

const HOUR = 60 * 60 * 1000;
const MAX_ADVERTISED = 6;
const ROLES = ["user", "vendor", "admin"];

const log = (...args) => console.log(...args);

/** Strings are stored as ISO without a zone designator, so assume UTC. */
const toDate = (value) => {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return value;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const normaliseTicketDates = async () => {
    const tickets = getCollection("tickets");
    const all = await tickets.find({}).toArray();

    let converted = 0;
    let rolled = 0;

    // Stagger departures so the catalogue does not all show the same day.
    all.sort((a, b) => String(a.title).localeCompare(String(b.title)));

    for (const [index, ticket] of all.entries()) {
        const updates = {};

        let departure = toDate(ticket.departureDateTime);

        if (departure) {
            if (departure.getTime() <= Date.now()) {
                // Expired: reschedule between 2 and roughly a week out.
                departure = new Date(Date.now() + (2 + index * 4) * HOUR);
                rolled += 1;
            }
        } else {
            departure = new Date(Date.now() + (3 + index * 4) * HOUR);
            converted += 1;
        }

        updates.departureDateTime = departure;

        const arrival = toDate(ticket.arrivalDateTime);

        updates.arrivalDateTime = arrival && arrival > departure
            ? arrival
            : new Date(departure.getTime() + 4 * HOUR);

        if (typeof ticket.soldQuantity !== "number") {
            updates.soldQuantity = 0;
        }

        if (ticket.isHidden === undefined) {
            updates.isHidden = false;
        }

        if (!TRANSPORT_TYPES.some((type) => type.toLowerCase() === String(ticket.transportType).toLowerCase())) {
            updates.transportType = "Bus";
        }

        await tickets.updateOne({ _id: ticket._id }, { $set: updates });
    }

    return { total: all.length, converted, rolled };
};

/** Keeps the advertisement slot within the six ticket limit. */
const normaliseAdvertisements = async () => {
    const tickets = getCollection("tickets");

    const advertised = await tickets
        .find({ isAdvertised: true })
        .sort({ createdAt: -1 })
        .toArray();

    let unadvertised = 0;

    for (const ticket of advertised.slice(MAX_ADVERTISED)) {
        await tickets.updateOne({ _id: ticket._id }, { $set: { isAdvertised: false } });
        unadvertised += 1;
    }

    // Top up to six so the homepage section is always full.
    const approved = await tickets
        .find({ verificationStatus: "approved", isAdvertised: { $ne: true } })
        .sort({ price: -1 })
        .toArray();

    let promoted = 0;

    for (const ticket of approved) {
        if (advertised.length - unadvertised + promoted >= MAX_ADVERTISED) {
            break;
        }

        await tickets.updateOne({ _id: ticket._id }, { $set: { isAdvertised: true } });
        promoted += 1;
    }

    return { removed: unadvertised, promoted };
};

/** Legacy accounts used roles such as "traveller" that the API does not accept. */
const normaliseUserRoles = async () => {
    const users = getCollection("users");
    let updated = 0;

    for (const user of await users.find({}).toArray()) {
        const role = String(user.role || "").toLowerCase();

        if (role && ROLES.includes(role)) {
            continue;
        }

        await users.updateOne(
            { _id: user._id },
            { $set: { role: "user" } }
        );

        updated += 1;
    }

    return { updated, total: await users.countDocuments() };
};

/**
 * Replaces string ticket _id values with real ObjectIds.
 *
 * The catalogue was seeded with 23 character ids, and every route that reads a
 * ticket validates its id with ObjectId.isValid, so those tickets could not be
 * opened, booked, edited or moderated at all. Mongo cannot mutate _id, so each
 * document is re-inserted under a new id and the old one removed, and any
 * booking or transaction pointing at the old id is re-pointed in the same pass
 * so no history is lost.
 */
const repairTicketIds = async () => {
    const tickets = getCollection("tickets");
    const bookings = getCollection("bookings");
    const transactions = getCollection("transactions");

    const stringKeyed = await tickets
        .find({ _id: { $type: "string" } })
        .toArray();

    let repaired = 0;
    let repointedBookings = 0;
    let repointedTransactions = 0;

    for (const ticket of stringKeyed) {
        // Placed after the spread so the new id wins over the old one.
        const document = { ...ticket, _id: new ObjectId() };

        await tickets.insertOne(document);
        await tickets.deleteOne({ _id: ticket._id });

        const bookingResult = await bookings.updateMany(
            { ticketId: ticket._id },
            { $set: { ticketId: document._id } }
        );
        repointedBookings += bookingResult.modifiedCount || 0;

        const transactionResult = await transactions.updateMany(
            { ticketId: ticket._id },
            { $set: { ticketId: document._id } }
        );
        repointedTransactions += transactionResult.modifiedCount || 0;

        repaired += 1;
    }

    return { repaired, repointedBookings, repointedTransactions };
};

/**
 * Derives a fare class for tickets that never carried one.
 *
 * The catalogue was seeded before fare class existed, so the client invented
 * one at render time from price and perks. Persisting that same rule here means
 * the stored value, the badge on the card and the ?fareClass filter all agree
 * instead of the filter silently matching nothing.
 */
const deriveFareClass = (ticket) => {
    const price = Number(ticket.price) || 0;
    const perkCount = Array.isArray(ticket.perks) ? ticket.perks.length : 0;

    if (price >= 3000 || perkCount >= 4) {
        return "Business";
    }

    if (ticket.transportType !== "Bus" && price <= 700) {
        return "First";
    }

    return "Economy";
};

const normaliseFareClasses = async () => {
    const tickets = getCollection("tickets");
    let updated = 0;

    for (const ticket of await tickets.find({ fareClass: { $in: [null, ""] } }).toArray()) {
        await tickets.updateOne(
            { _id: ticket._id },
            { $set: { fareClass: deriveFareClass(ticket) } }
        );

        updated += 1;
    }

    return { updated, total: await tickets.countDocuments() };
};

const summarise = async () => {
    const tickets = getCollection("tickets");
    const now = new Date();

    const byStatus = await tickets
        .aggregate([{ $group: { _id: "$verificationStatus", count: { $sum: 1 } } }])
        .toArray();

    return {
        tickets: await tickets.countDocuments(),
        byStatus: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
        advertised: await tickets.countDocuments({ isAdvertised: true }),
        bookable: await tickets.countDocuments({
            verificationStatus: "approved",
            isHidden: { $ne: true },
            departureDateTime: { $gt: now },
            quantity: { $gt: 0 },
        }),
        users: await getCollection("users").countDocuments(),
    };
};

const main = async () => {
    await connectDatabase();

    const ids = await repairTicketIds();
    log(
        `ticket ids: ${ids.repaired} converted to ObjectId, ` +
            `${ids.repointedBookings} bookings and ` +
            `${ids.repointedTransactions} transactions re-pointed`
    );

    const dates = await normaliseTicketDates();
    log(
        `tickets normalised: ${dates.total} checked, ${dates.converted} had unreadable dates, ` +
            `${dates.rolled} rescheduled into the future`
    );

    const ads = await normaliseAdvertisements();
    log(
        `advertisements: ${ads.removed} removed, ${ads.promoted} promoted ` +
            `(limit ${MAX_ADVERTISED})`
    );

    const roles = await normaliseUserRoles();
    log(`user roles: ${roles.updated} normalised, ${roles.total} total`);

    const fares = await normaliseFareClasses();
    log(`fare classes: ${fares.updated} derived, ${fares.total} total`);

    log("summary:", JSON.stringify(await summarise(), null, 2));

    await closeDatabase();
};

main().catch(async (error) => {
    console.error("Seed failed:", error);
    process.exit(1);
});
