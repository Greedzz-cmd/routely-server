/**
 * Idempotent maintenance and demo seed.
 *
 * Run with: npm run seed
 *
 * Earlier iterations of this project stored departureDateTime as a string,
 * which silently breaks every date comparison and sort in Mongo, and the sample
 * catalogue drifted past the six advertisement limit. This script normalises
 * the data, pulls expired departures back into the future so the catalogue is
 * bookable for a demo, and leaves a realistic spread of verification statuses
 * for the admin tables.
 *
 * Safe to run repeatedly.
 */
const { connectDatabase, getCollection, closeDatabase } = require("../src/config/db");
const { TRANSPORT_TYPES } = require("../src/models/ticket.model");

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

    log("summary:", JSON.stringify(await summarise(), null, 2));

    await closeDatabase();
};

main().catch(async (error) => {
    console.error("Seed failed:", error);
    process.exit(1);
});
