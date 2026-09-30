const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, isAdmin, readRole } = require("../middleware/auth");
const { parseObjectId } = require("../middleware/errorHandler");
const ApiError = require("../utils/ApiError");
const { env } = require("../config/env");
const paymentService = require("../services/payment.service");
const {
    createBooking,
    listBookingsForUser,
    listBookingsForVendor,
    respondToBooking,
    cancelBooking,
    findBookingById,
    markBookingPaid,
} = require("../models/booking.model");
const { recordTransaction } = require("../models/transaction.model");

/**
 * Decides whose bookings a listing returns.
 *
 * A booking has two owners: the traveller who bought seats (userEmail) and the
 * vendor who has to answer the request (vendorEmail). The same account can be
 * both, so the caller states which side it wants via ?vendorEmail / ?userEmail.
 * An admin may name either; everyone else is pinned to their own address.
 */
const resolveListOwner = (req) => {
    const askedVendor = String(req.query.vendorEmail || "").trim();
    const askedUser = String(req.query.userEmail || "").trim();
    const ownEmail = String(req.user.email);
    const isSelf = (value) => value.toLowerCase() === ownEmail.toLowerCase();

    if (askedVendor) {
        if (isAdmin(req.user)) {
            return { email: askedVendor, isVendor: true };
        }

        if (readRole(req.user) === "vendor" && isSelf(askedVendor)) {
            return { email: ownEmail, isVendor: true };
        }

        throw ApiError.forbidden("You can only view your own bookings.");
    }

    if (askedUser) {
        if (!isAdmin(req.user) && !isSelf(askedUser)) {
            throw ApiError.forbidden("You can only view your own bookings.");
        }

        return { email: askedUser, isVendor: false };
    }

    return { email: ownEmail, isVendor: false };
};

const getBookings = asyncHandler(async (req, res) => {
    const { email, isVendor } = resolveListOwner(req);

    const bookings = isVendor
        ? await listBookingsForVendor(email, { status: req.query.status })
        : await listBookingsForUser(email);

    res.json(bookings);
});

const createBookingRequest = asyncHandler(async (req, res) => {
    const ticketId = parseObjectId(req.body.ticketId, "ticket id");
    const booking = await createBooking({
        ticketId,
        quantity: req.body.quantity,
        user: req.user,
    });

    res.status(201).json({
        message: "Booking request submitted.",
        booking,
    });
});

/** A single booking the caller is allowed to see. */
const getBookingById = asyncHandler(async (req, res) => {
    const booking = await findBookingById(parseObjectId(req.params.id, "booking id"));

    if (!booking) {
        throw ApiError.notFound("Booking not found.");
    }

    const isParticipant =
        booking.userId === String(req.user.id) ||
        String(booking.vendorEmail || "").toLowerCase() === String(req.user.email).toLowerCase();

    if (!isParticipant && !isAdmin(req.user)) {
        throw ApiError.forbidden("You cannot view this booking.");
    }

    res.json({ ...booking, id: String(booking._id) });
});

/** Vendor accepts or rejects a pending request. */
const respondToBookingRequest = asyncHandler(async (req, res) => {
    const booking = await respondToBooking(
        parseObjectId(req.params.id, "booking id"),
        req.user.email,
        req.body.status
    );

    res.json({
        message: `Booking ${booking.status}.`,
        booking,
    });
});

const cancelBookingRequest = asyncHandler(async (req, res) => {
    const booking = await cancelBooking(parseObjectId(req.params.id, "booking id"), req.user);

    res.json({ message: "Booking cancelled.", booking });
});

/** Starts a Stripe Checkout session for an accepted booking. */
const startCheckout = asyncHandler(async (req, res) => {
    const booking = await findBookingById(parseObjectId(req.params.id, "booking id"));

    if (!booking) {
        throw ApiError.notFound("Booking not found.");
    }

    if (booking.userId !== String(req.user.id) && !isAdmin(req.user)) {
        throw ApiError.forbidden("You can only pay for your own booking.");
    }

    if (booking.status === "paid") {
        throw ApiError.conflict("This booking is already paid.");
    }

    if (booking.status !== "accepted") {
        throw ApiError.badRequest(
            `Payment is available once the vendor accepts (currently ${booking.status}).`
        );
    }

    if (new Date(booking.departureDateTime).getTime() <= Date.now()) {
        throw ApiError.badRequest("Departure time has passed, payment is no longer possible.");
    }

    const session = await paymentService.createCheckoutSession({
        booking,
        user: req.user,
    });

    res.json({
        message: "Checkout session created.",
        sessionId: session.sessionId,
        url: session.url,
        mock: session.mock,
        amount: session.amount,
        currency: env.payments.currency,
    });
});

/**
 * Confirms a mock payment. Only available in mock mode, where there is no
 * Stripe hosted page to return from.
 */
const confirmMockPayment = asyncHandler(async (req, res) => {
    if (!paymentService.isMock) {
        throw ApiError.notFound("Not available when Stripe is enabled.");
    }

    const bookingId = parseObjectId(req.body.bookingId || req.params.id, "booking id");

    const { booking, alreadyPaid } = await markBookingPaid(bookingId);

    await recordTransaction({
        booking,
        provider: "mock",
        transactionId: `mock_txn_${Date.now()}`,
    });

    res.json({
        message: alreadyPaid ? "Payment was already recorded." : "Payment completed.",
        booking,
    });
});

/** Confirms a payment by looking the session up, used as the webhook fallback. */
const confirmPayment = asyncHandler(async (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
        throw ApiError.badRequest("sessionId is required.");
    }

    const session = await paymentService.retrieveSession(sessionId);
    const bookingId = session.metadata?.bookingId || session.client_reference_id;

    if (!bookingId) {
        throw ApiError.badRequest("That session is not linked to a booking.");
    }

    if (session.payment_status && session.payment_status !== "paid") {
        throw ApiError.badRequest("Payment has not completed yet.");
    }

    const { booking, alreadyPaid } = await markBookingPaid(bookingId, {
        transactionId: session.payment_intent || session.id,
    });

    if (!alreadyPaid) {
        await recordTransaction({
            booking,
            provider: "stripe",
            transactionId: session.payment_intent || session.id,
        });
    }

    res.json({
        message: "Payment recorded.",
        booking,
        alreadyPaid,
    });
});

module.exports = {
    getBookings,
    createBookingRequest,
    getBookingById,
    respondToBookingRequest,
    cancelBookingRequest,
    startCheckout,
    confirmMockPayment,
    confirmPayment,
};
