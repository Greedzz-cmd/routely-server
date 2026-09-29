const { getCollection } = require("../config/db");
const ApiError = require("../utils/ApiError");
const { toNumber } = require("./ticket.model");

/**
 * Records a completed payment.
 *
 * The unique index on bookingId makes this idempotent: a replayed Stripe
 * webhook updates the existing row instead of creating a duplicate, so the
 * transaction history stays one row per booking.
 */
const recordTransaction = async ({ booking, provider, transactionId, currency = "bdt" }) => {
    if (!booking) {
        throw ApiError.badRequest("A booking is required to record a transaction.");
    }

    const record = {
        transactionId: transactionId || `txn_${booking._id}`,
        provider: provider || "stripe",

        bookingId: booking._id,
        pnr: booking.pnr,
        ticketId: booking.ticketId,
        ticketTitle: booking.ticketTitle,

        userId: booking.userId,
        userEmail: booking.userEmail,
        userName: booking.userName,

        vendorEmail: booking.vendorEmail || null,
        vendorId: booking.vendorId || null,

        quantity: booking.quantity,
        unitPrice: toNumber(booking.pricePerSeat) || 0,
        amount: toNumber(booking.totalPrice) || 0,
        currency,

        paidAt: new Date(),
        createdAt: new Date(),
    };

    try {
        await getCollection("transactions").insertOne(record);
    } catch (error) {
        if (error.code === 11000) {
            return { ...record, duplicate: true };
        }

        throw error;
    }

    return record;
};

/** A user's payment history, newest first. */
const listTransactionsForUser = async (email) => {
    const transactions = await getCollection("transactions")
        .find({ userEmail: { $regex: `^${email}$`, $options: "i" } })
        .sort({ paidAt: -1 })
        .toArray();

    return transactions.map((transaction) => ({
        ...transaction,
        id: String(transaction._id),
    }));
};

/** A vendor's sales, used by the revenue overview. */
const listTransactionsForVendor = async (email) => {
    const transactions = await getCollection("transactions")
        .find({ vendorEmail: { $regex: `^${email}$`, $options: "i" } })
        .sort({ paidAt: -1 })
        .toArray();

    return transactions.map((transaction) => ({
        ...transaction,
        id: String(transaction._id),
    }));
};

module.exports = {
    recordTransaction,
    listTransactionsForUser,
    listTransactionsForVendor,
};
