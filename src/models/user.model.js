const { ObjectId } = require("mongodb");

const { getCollection } = require("../config/db");
const ApiError = require("../utils/ApiError");

const ROLES = ["user", "vendor", "admin"];

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Better Auth ids are ObjectId strings, but seeded rows may use other keys. */
const buildUserIdFilter = (id) =>
    ObjectId.isValid(String(id)) ? { _id: new ObjectId(String(id)) } : { _id: id };

const toPlainId = (user) => ({
    ...user,
    id: String(user._id),
    role: String(user.role || "user").toLowerCase(),
    isFraud: Boolean(user.isFraud),
});

const findUserByEmail = (email) =>
    getCollection("users").findOne({ email: { $regex: `^${escapeRegExp(email)}$`, $options: "i" } });

/** Full user list for the admin Manage Users table. */
const listUsers = async ({ search, role } = {}) => {
    const query = {};

    if (search) {
        const term = escapeRegExp(search);
        query.$or = [
            { name: { $regex: term, $options: "i" } },
            { email: { $regex: term, $options: "i" } },
        ];
    }

    if (role && ROLES.includes(String(role).toLowerCase())) {
        query.role = String(role).toLowerCase();
    }

    const users = await getCollection("users")
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

    return users.map(toPlainId);
};

const findUserById = async (id) => {
    const user = await getCollection("users").findOne(buildUserIdFilter(id));

    return user ? toPlainId(user) : null;
};

/** Promotes or demotes a user. Vendors cannot be granted to unverified accounts. */
const updateUserRole = async (id, role) => {
    const nextRole = String(role || "").toLowerCase();

    if (!ROLES.includes(nextRole)) {
        throw ApiError.badRequest(`Role must be one of: ${ROLES.join(", ")}.`);
    }

    const user = await getCollection("users").findOne(buildUserIdFilter(id));

    if (!user) {
        throw ApiError.notFound("User not found.");
    }

    await getCollection("users").updateOne(
        { _id: user._id },
        {
            $set: {
                role: nextRole,
                // Lifting a fraud flag also restores the vendor's catalogue.
                ...(nextRole !== "vendor" ? { isFraud: false } : {}),
                updatedAt: new Date(),
            },
        }
    );

    return toPlainId({ ...user, role: nextRole, isFraud: nextRole !== "vendor" ? false : user.isFraud });
};

/**
 * Marks a vendor as fraud.
 *
 * Their tickets are hidden from every public listing in the same operation, and
 * the vendor can no longer publish. Bookings already taken are untouched so
 * travellers who already paid are not affected.
 */
const setFraudStatus = async (id, isFraud) => {
    const flag = Boolean(isFraud);

    const user = await getCollection("users").findOne(buildUserIdFilter(id));

    if (!user) {
        throw ApiError.notFound("User not found.");
    }

    if (String(user.role).toLowerCase() !== "vendor") {
        throw ApiError.badRequest("Only vendors can be marked as fraud.");
    }

    await getCollection("users").updateOne(
        { _id: user._id },
        { $set: { isFraud: flag, updatedAt: new Date() } }
    );

    const ticketUpdate = flag
        ? { $set: { isHidden: true, isAdvertised: false, updatedAt: new Date() } }
        : { $set: { isHidden: false, updatedAt: new Date() } };

    const ticketResult = await getCollection("tickets").updateMany(
        { vendorId: String(user._id) },
        ticketUpdate
    );

    // Fall back to email for rows whose vendorId was stored differently.
    if (ticketResult.matchedCount === 0 && user.email) {
        await getCollection("tickets").updateMany(
            { vendorEmail: { $regex: `^${escapeRegExp(user.email)}$`, $options: "i" } },
            ticketUpdate
        );
    }

    return {
        user: toPlainId({ ...user, isFraud: flag }),
        affectedTickets: ticketResult.matchedCount,
    };
};

module.exports = {
    ROLES,
    listUsers,
    findUserById,
    findUserByEmail,
    updateUserRole,
    setFraudStatus,
    escapeRegExp,
    toPlainId,
};
