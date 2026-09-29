const asyncHandler = require("../middleware/asyncHandler");
const { getDatabase } = require("../config/db");
const ApiError = require("../utils/ApiError");
const {
    listUsers,
    findUserById,
    findUserByEmail,
    updateUserRole,
    setFraudStatus,
} = require("../models/user.model");
const {
    listTransactionsForUser,
    listTransactionsForVendor,
} = require("../models/transaction.model");
const { listBookingsForVendor } = require("../models/booking.model");

/** Every registered account, for the admin Manage Users table. */
const getUsers = asyncHandler(async (req, res) => {
    const users = await listUsers({ search: req.query.search, role: req.query.role });

    res.json(users);
});

/** The caller's own stored record, including the fraud flag. */
const getCurrentUser = asyncHandler(async (req, res) => {
    const byId = await findUserById(req.user.id);
    const user = byId || (await findUserByEmail(req.user.email));

    if (!user) {
        // The account exists in the token but not yet in the synced collection.
        res.json({
            id: String(req.user.id),
            name: req.user.name || req.user.email,
            email: req.user.email,
            image: req.user.image || null,
            role: String(req.user.role || "user").toLowerCase(),
            isFraud: false,
        });
        return;
    }

    res.json(user);
});

const changeRole = asyncHandler(async (req, res) => {
    const role = req.body?.role;

    // An admin demoting themselves would leave nobody able to undo it.
    if (String(req.user.id) === String(req.params.id) && String(role).toLowerCase() !== "admin") {
        throw ApiError.badRequest("You cannot change your own role.");
    }

    const user = await updateUserRole(req.params.id, role);

    res.json({
        message: `${user.name || user.email} is now a ${user.role}.`,
        user,
    });
});

const setFraud = asyncHandler(async (req, res) => {
    // The admin button sends no body and means "flag as fraud"; passing
    // isFraud: false explicitly is how a flag is lifted.
    const isFraud =
        typeof req.body?.isFraud === "boolean" ? req.body.isFraud : true;

    const { user, affectedTickets } = await setFraudStatus(req.params.id, isFraud);

    res.json({
        message: isFraud
            ? `${user.name || user.email} was marked as fraud. ${affectedTickets} ticket(s) hidden.`
            : `${user.name || user.email} was reinstated.`,
        user,
        affectedTickets,
    });
});

/** Payment history for the caller's own account. */
const getMyTransactions = asyncHandler(async (req, res) => {
    const email = req.user.email;
    const transactions = await listTransactionsForUser(email);

    res.json(transactions);
});

/**
 * Revenue overview for the vendor dashboard: totals plus a monthly series for
 * the chart, all derived from paid transactions and their own tickets.
 */
const getVendorStats = asyncHandler(async (req, res) => {
    const email = req.user.email;
    const vendorId = String(req.user.id);

    const db = getDatabase();
    const vendorTicketFilter = {
        $or: [
            { vendorId },
            { vendorEmail: { $regex: `^${email}$`, $options: "i" } },
        ],
    };

    const [transactions, ticketSummary, bookings] = await Promise.all([
        // A stats failure should not blank the whole dashboard.
        listTransactionsForVendor(email).catch((error) => {
            console.error("Failed to load vendor transactions:", error.message);
            return [];
        }),
        db.collection("tickets")
            .aggregate([
                { $match: vendorTicketFilter },
                {
                    $group: {
                        _id: null,
                        totalTicketsAdded: { $sum: 1 },
                        totalSeats: { $sum: "$quantity" },
                        totalSold: { $sum: { $ifNull: ["$soldQuantity", 0] } },
                    },
                },
            ])
            .toArray(),
        listBookingsForVendor(email).catch(() => []),
    ]);

    const summary = ticketSummary[0] || {};
    const totalRevenue = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalTicketsSold = transactions.reduce((sum, t) => sum + (t.quantity || 0), 0);

    // Last six months of sales, oldest first, so the chart reads left to right.
    const monthly = new Map();

    for (const transaction of transactions) {
        const key = new Date(transaction.paidAt).toISOString().slice(0, 7);

        const entry = monthly.get(key) || { month: key, revenue: 0, tickets: 0 };

        entry.revenue += transaction.amount || 0;
        entry.tickets += transaction.quantity || 0;
        monthly.set(key, entry);
    }

    res.json({
        vendorEmail: email,
        totalTicketsAdded: summary.totalTicketsAdded || 0,
        totalTicketsSold,
        totalRevenue,
        totalSeats: summary.totalSeats || 0,
        totalBookings: bookings.length,
        monthlyRevenue: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
        recentTransactions: transactions.slice(0, 5),
    });
});

/** Platform totals for the admin dashboard. */
const getAdminStats = asyncHandler(async (_req, res) => {
    const db = getDatabase();

    const [[ticketStats], [bookingStats], [userStats]] = await Promise.all([
        db.collection("tickets")
            .aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        approved: { $sum: { $cond: [{ $eq: ["$verificationStatus", "approved"] }, 1, 0] } },
                        pending: { $sum: { $cond: [{ $eq: ["$verificationStatus", "pending"] }, 1, 0] } },
                        advertised: { $sum: { $cond: ["$isAdvertised", 1, 0] } },
                    },
                },
            ])
            .toArray(),
        db.collection("bookings")
            .aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ])
            .toArray(),
        db.collection("user")
            .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
            .toArray(),
    ]);

    const byStatus = Object.fromEntries(bookingStats.map((row) => [row._id, row.count]));

    res.json({
        tickets: {
            total: ticketStats?.total || 0,
            approved: ticketStats?.approved || 0,
            pending: ticketStats?.pending || 0,
            advertised: ticketStats?.advertised || 0,
        },
        bookings: {
            total: bookingStats.reduce((sum, row) => sum + row.count, 0),
            ...byStatus,
        },
        users: Object.fromEntries(userStats.map((row) => [row._id || "user", row.count])),
    });
});

module.exports = {
    getUsers,
    getCurrentUser,
    changeRole,
    setFraud,
    getMyTransactions,
    getVendorStats,
    getAdminStats,
};
