const crypto = require("crypto");

const { getCollection } = require("../config/db");
const ApiError = require("../utils/ApiError");
const { findTicketById, toNumber } = require("./ticket.model");

const BOOKING_STATUSES = ["pending", "accepted", "rejected", "paid", "cancelled"];

/** Statuses that still hold a claim on ticket inventory. */
const ACTIVE_STATUSES = ["pending", "accepted", "paid"];

const generatePnr = () => `RLY-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

/** Adds a plain `id` alongside the Mongo `_id` for the client. */
const serializeBooking = (booking) =>
    booking ? { ...booking, id: String(booking._id) } : booking;

const isDeparted = (departureDateTime) =>
    !!departureDateTime && new Date(departureDateTime).getTime() <= Date.now();

/**
 * Seats already spoken for: sold seats plus anything a vendor has not yet
 * answered. Checked at booking time so the inventory is not oversold before
 * anyone has paid.
 */
const reservedQuantity = async (ticketId, excludeBookingId) => {
    const query = {
        ticketId,
        status: { $in: ACTIVE_STATUSES },
    };

    if (excludeBookingId) {
        query._id = { $ne: excludeBookingId };
    }

    const rows = await getCollection("bookings")
        .aggregate([
            { $match: query },
            { $group: { _id: null, total: { $sum: "$quantity" } } },
        ])
        .toArray();

    return rows[0]?.total || 0;
};

/**
 * Creates a pending booking request.
 *
 * The ticket quantity is intentionally NOT decremented here: the assignment
 * reduces inventory only after Stripe confirms payment, so an abandoned or
 * rejected request does not permanently consume seats.
 */
const createBooking = async ({ ticketId, quantity, user }) => {
    const seats = Number(quantity);

    if (!Number.isInteger(seats) || seats < 1) {
        throw ApiError.badRequest("Booking quantity must be a whole number of at least 1.");
    }

    const ticket = await findTicketById(ticketId);

    if (!ticket) {
        throw ApiError.notFound("Ticket not found.");
    }

    if (ticket.verificationStatus !== "approved") {
        throw ApiError.badRequest("This ticket is not open for booking.");
    }

    if (ticket.isHidden) {
        throw ApiError.notFound("This ticket is no longer available.");
    }

    if (isDeparted(ticket.departureDateTime)) {
        throw ApiError.badRequest("Departure time has already passed.");
    }

    const available = Math.max(
        0,
        (Number(ticket.quantity) || 0) - (await reservedQuantity(ticket._id))
    );

    if (seats > available) {
        throw ApiError.conflict(
            available === 0
                ? "This ticket is sold out."
                : `Only ${available} seat${available === 1 ? "" : "s"} left.`
        );
    }

    const pricePerSeat = toNumber(ticket.price) || 0;
    const now = new Date();

    const booking = {
        pnr: generatePnr(),

        userId: String(user.id),
        userName: user.name || user.email,
        userEmail: user.email,

        ticketId: ticket._id,
        ticketTitle: ticket.title,
        vendorId: ticket.vendorId || null,
        vendorEmail: ticket.vendorEmail || null,
        vendorName: ticket.vendorName || null,

        from: ticket.from,
        to: ticket.to,
        transportType: ticket.transportType || "Bus",
        operator: ticket.operator || ticket.vendorName || ticket.title,
        image: ticket.image || null,
        departureDateTime: ticket.departureDateTime,

        quantity: seats,
        pricePerSeat,
        totalPrice: seats * pricePerSeat,

        status: "pending",
        paidAt: null,
        transactionId: null,
        createdAt: now,
        updatedAt: now,
    };

    const result = await getCollection("bookings").insertOne(booking);

    return serializeBooking({ ...booking, _id: result.insertedId });
};

const findBookingById = (id) => getCollection("bookings").findOne({ _id: id });

/** A user's own bookings, newest first. */
const listBookingsForUser = async (email) => {
    const bookings = await getCollection("bookings")
        .find({ userEmail: { $regex: `^${email}$`, $options: "i" } })
        .sort({ createdAt: -1 })
        .toArray();

    return bookings.map(serializeBooking);
};

/** Bookings awaiting a vendor decision, plus their outcome history. */
const listBookingsForVendor = async (email, { status } = {}) => {
    const query = { vendorEmail: { $regex: `^${email}$`, $options: "i" } };

    if (status) {
        query.status = status;
    }

    const bookings = await getCollection("bookings").find(query).sort({ createdAt: -1 }).toArray();

    return bookings.map(serializeBooking);
};

/** Vendor accepts or rejects a pending request. */
const respondToBooking = async (id, vendorEmail, status) => {
    if (!["accepted", "rejected"].includes(status)) {
        throw ApiError.badRequest("Status must be accepted or rejected.");
    }

    const booking = await findBookingById(id);

    if (!booking) {
        throw ApiError.notFound("Booking not found.");
    }

    if (
        booking.vendorEmail &&
        booking.vendorEmail.toLowerCase() !== String(vendorEmail).toLowerCase()
    ) {
        throw ApiError.forbidden("This booking belongs to another vendor.");
    }

    if (booking.status !== "pending") {
        throw ApiError.conflict(`This booking was already ${booking.status}.`);
    }

    await getCollection("bookings").updateOne(
        { _id: id, status: "pending" },
        { $set: { status, updatedAt: new Date() } }
    );

    return serializeBooking({ ...booking, status, updatedAt: new Date() });
};

/**
 * Users may withdraw a request, but only while the vendor has not answered.
 * Releasing the claim is implicit because cancelled bookings drop out of the
 * reserved quantity calculation.
 */
const cancelBooking = async (id, user) => {
    const booking = await findBookingById(id);

    if (!booking) {
        throw ApiError.notFound("Booking not found.");
    }

    const isOwner = booking.userId === String(user.id);

    if (!isOwner && String(user.role).toLowerCase() !== "admin") {
        throw ApiError.forbidden("You can only cancel your own booking.");
    }

    if (booking.status !== "pending") {
        throw ApiError.conflict("Only a pending booking can be cancelled.");
    }

    await getCollection("bookings").updateOne(
        { _id: id, status: "pending" },
        { $set: { status: "cancelled", updatedAt: new Date() } }
    );

    return serializeBooking({ ...booking, status: "cancelled" });
};

/**
 * Marks a booking paid and consumes inventory exactly once.
 *
 * Called from the Stripe webhook (and from the mock gateway). The guarded
 * update means a replayed webhook cannot double decrement the ticket.
 */
const markBookingPaid = async (id, { transactionId, paidAt } = {}) => {
    const bookings = getCollection("bookings");
    const booking = await findBookingById(id);

    if (!booking) {
        throw ApiError.notFound("Booking not found.");
    }

    if (booking.status === "paid") {
        return { booking: serializeBooking(booking), alreadyPaid: true };
    }

    if (booking.status !== "accepted") {
        throw ApiError.conflict(
            `Payment requires an accepted booking (currently ${booking.status}).`
        );
    }

    if (isDeparted(booking.departureDateTime)) {
        throw ApiError.badRequest("Departure time has passed, payment is no longer possible.");
    }

    const tickets = getCollection("tickets");
    const decrement = await tickets.updateOne(
        { _id: booking.ticketId, quantity: { $gte: booking.quantity } },
        {
            $inc: { quantity: -booking.quantity, soldQuantity: booking.quantity },
            $set: { updatedAt: new Date() },
        }
    );

    if (decrement.modifiedCount === 0) {
        throw ApiError.conflict("The remaining seats were sold before payment completed.");
    }

    const result = await bookings.findOneAndUpdate(
        { _id: id, status: "accepted" },
        {
            $set: {
                status: "paid",
                paidAt: paidAt || new Date(),
                transactionId: transactionId || null,
                updatedAt: new Date(),
            },
        },
        { returnDocument: "after", includeResultMetadata: false }
    );

    if (!result) {
        // Roll the seats back if a concurrent transition won the race.
        await tickets.updateOne(
            { _id: booking.ticketId },
            { $inc: { quantity: booking.quantity, soldQuantity: -booking.quantity } }
        );

        throw ApiError.conflict("This booking is no longer awaiting payment.");
    }

    return { booking: serializeBooking(result), alreadyPaid: false };
};

module.exports = {
    BOOKING_STATUSES,
    ACTIVE_STATUSES,
    generatePnr,
    serializeBooking,
    isDeparted,
    reservedQuantity,
    createBooking,
    findBookingById,
    listBookingsForUser,
    listBookingsForVendor,
    respondToBooking,
    cancelBooking,
    markBookingPaid,
};
