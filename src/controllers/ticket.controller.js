const { getCollection } = require("../config/db");
const ApiError = require("../utils/ApiError");
const asyncHandler = require("../middleware/asyncHandler");
const { isAdmin, readRole } = require("../middleware/auth");
const { parseObjectId } = require("../middleware/errorHandler");
const {
    listTickets,
    findTicketById,
    validateTicketPayload,
    buildTicketQuery,
} = require("../models/ticket.model");

const MAX_ADVERTISED = 6;

/** Public listing. Defaults to approved, non hidden tickets. */
const getTickets = asyncHandler(async (req, res) => {
    const {
        from,
        to,
        transportType,
        q,
        search,
        sort,
        page,
        limit,
    } = req.query;

    const result = await listTickets({
        from,
        to,
        transportType,
        search: search || q,
        sort,
        page,
        limit,
    });

    res.json({
        tickets: result.tickets,
        pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
            totalPages: result.totalPages,
            hasNextPage: result.page < result.totalPages,
            hasPrevPage: result.page > 1,
        },
    });
});

/** The six tickets admins may feature on the homepage. */
const getAdvertisedTickets = asyncHandler(async (_req, res) => {
    const result = await listTickets({
        verificationStatus: "approved",
        isAdvertised: true,
        sort: "newest",
        page: 1,
        limit: MAX_ADVERTISED,
    });

    res.json(result.tickets.slice(0, MAX_ADVERTISED));
});

const getTicketById = asyncHandler(async (req, res) => {
    const ticket = await findTicketById(parseObjectId(req.params.id, "ticket id"));

    if (!ticket) {
        throw ApiError.notFound("Ticket not found.");
    }

    // Unapproved tickets stay visible to their owner and to admins only.
    const role = readRole(req.user);
    const isOwner = req.user && ticket.vendorId === String(req.user.id);

    if (ticket.verificationStatus !== "approved" && !isOwner && role !== "admin") {
        throw ApiError.notFound("Ticket not found.");
    }

    res.json(ticket);
});

/** All tickets for the admin Manage Tickets table, any verification status. */
const getTicketsForAdmin = asyncHandler(async (req, res) => {
    const { verificationStatus, page, limit, search } = req.query;

    const result = await listTickets({
        verificationStatus: verificationStatus || undefined,
        includeHidden: true,
        search,
        page,
        limit,
        sort: "newest",
    });

    res.json({
        tickets: result.tickets,
        pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
            totalPages: result.totalPages,
        },
    });
});

/** A vendor's own tickets, with their verification status. */
const getMyTickets = asyncHandler(async (req, res) => {
    const result = await listTickets({
        vendorEmail: req.user.email,
        verificationStatus: req.query.verificationStatus || undefined,
        includeHidden: true,
        page: req.query.page,
        limit: req.query.limit,
        sort: "newest",
    });

    res.json({
        tickets: result.tickets,
        pagination: {
            page: result.page,
            limit: result.limit,
            total: result.total,
            totalPages: result.totalPages,
        },
    });
});

const createTicket = asyncHandler(async (req, res) => {
    const data = validateTicketPayload(req.body);

    // A vendor marked as fraud can no longer publish tickets.
    const owner = await getCollection("users").findOne(
        { email: { $regex: `^${req.user.email}$`, $options: "i" } },
        { projection: { isFraud: 1, role: 1 } }
    );

    if (owner?.isFraud) {
        throw ApiError.forbidden(
            "Your vendor account is marked as fraud and cannot add tickets."
        );
    }

    const now = new Date();
    const ticket = {
        ...data,
        vendorId: String(req.user.id),
        vendorName: req.user.name || req.user.email,
        vendorEmail: req.user.email,
        verificationStatus: "pending",
        isAdvertised: false,
        isHidden: false,
        soldQuantity: 0,
        createdAt: now,
        updatedAt: now,
    };

    const result = await getCollection("tickets").insertOne(ticket);

    res.status(201).json({
        message: "Ticket created and sent for verification.",
        ticket: { ...ticket, _id: result.insertedId },
    });
});

/** Partial update restricted to the fields a vendor owns. */
const updateTicket = asyncHandler(async (req, res) => {
    const ticketId = parseObjectId(req.params.id, "ticket id");
    const existing = await findTicketById(ticketId);

    if (!existing) {
        throw ApiError.notFound("Ticket not found.");
    }

    const role = readRole(req.user);
    const isOwner = existing.vendorId === String(req.user.id);

    if (!isAdmin(req.user) && !isOwner) {
        throw ApiError.forbidden("You can only edit your own tickets.");
    }

    // Rejected tickets are locked so a vendor cannot resubmit them silently.
    if (existing.verificationStatus === "rejected" && !isAdmin(req.user)) {
        throw ApiError.forbidden("Rejected tickets cannot be edited.");
    }

    const updates = {};

    if (req.body.title !== undefined || req.body.from !== undefined ||
        req.body.to !== undefined || req.body.price !== undefined ||
        req.body.quantity !== undefined || req.body.transportType !== undefined ||
        req.body.departureDateTime !== undefined) {
        const validated = validateTicketPayload(
            {
                title: req.body.title ?? existing.title,
                from: req.body.from ?? existing.from,
                to: req.body.to ?? existing.to,
                price: req.body.price ?? existing.price,
                quantity: req.body.quantity ?? existing.quantity,
                totalSeats: req.body.totalSeats ?? existing.totalSeats,
                transportType: req.body.transportType ?? existing.transportType,
                fareClass: req.body.fareClass ?? existing.fareClass,
                duration: req.body.duration ?? existing.duration,
                image: req.body.image ?? existing.image,
                perks: req.body.perks ?? existing.perks,
                operator: req.body.operator ?? existing.operator,
                arrivalDateTime: req.body.arrivalDateTime ?? existing.arrivalDateTime,
                departureDateTime: req.body.departureDateTime ?? existing.departureDateTime,
            },
            // A ticket that has already departed may still have its details
            // corrected, but a new departure must be in the future.
            { requireFutureDeparture: req.body.departureDateTime !== undefined }
        );

        Object.assign(updates, validated);
    }

    if (req.body.image !== undefined) {
        updates.image = String(req.body.image || "").trim();
    }

    if (req.body.perks !== undefined) {
        updates.perks = Array.isArray(req.body.perks) ? req.body.perks : [];
    }

    if (updates.quantity !== undefined && updates.quantity < (existing.soldQuantity || 0)) {
        throw ApiError.badRequest(
            `Quantity cannot drop below the ${existing.soldQuantity} seats already sold.`
        );
    }

    // A vendor edit sends the ticket back through verification.
    if (!isAdmin(req.user) && existing.verificationStatus === "approved") {
        updates.verificationStatus = "pending";
    }

    updates.updatedAt = new Date();

    await getCollection("tickets").updateOne({ _id: ticketId }, { $set: updates });

    res.json({
        message: "Ticket updated.",
        ticket: { ...existing, ...updates },
    });
});

const deleteTicket = asyncHandler(async (req, res) => {
    const ticketId = parseObjectId(req.params.id, "ticket id");
    const existing = await findTicketById(ticketId);

    if (!existing) {
        throw ApiError.notFound("Ticket not found.");
    }

    const isOwner = existing.vendorId === String(req.user.id);

    if (!isAdmin(req.user) && !isOwner) {
        throw ApiError.forbidden("You can only delete your own tickets.");
    }

    if (existing.verificationStatus === "rejected" && !isAdmin(req.user)) {
        throw ApiError.forbidden("Rejected tickets cannot be deleted.");
    }

    const hasActiveBookings = await getCollection("bookings").countDocuments({
        ticketId,
        status: { $in: ["pending", "accepted"] },
    });

    if (hasActiveBookings > 0) {
        throw ApiError.conflict(
            "This ticket has active bookings and cannot be deleted yet."
        );
    }

    await getCollection("tickets").deleteOne({ _id: ticketId });

    res.json({ message: "Ticket deleted." });
});

/** Admin approve or reject. Rejected tickets stop appearing publicly. */
const moderateTicket = asyncHandler(async (req, res) => {
    const ticketId = parseObjectId(req.params.id, "ticket id");
    const { action } = req.body || {};

    if (!["approve", "reject"].includes(action)) {
        throw ApiError.badRequest("Action must be 'approve' or 'reject'.");
    }

    const verificationStatus = action === "approve" ? "approved" : "rejected";

    const result = await getCollection("tickets").findOneAndUpdate(
        { _id: ticketId },
        {
            $set: {
                verificationStatus,
                // Rejected tickets can never stay advertised.
                ...(verificationStatus === "rejected" ? { isAdvertised: false } : {}),
                updatedAt: new Date(),
            },
        },
        { returnDocument: "after", includeResultMetadata: false }
    );

    if (!result) {
        throw ApiError.notFound("Ticket not found.");
    }

    res.json({
        message: `Ticket ${verificationStatus}.`,
        ticket: result,
    });
});

/** Admin advertise toggle, capped at six live advertisements. */
const toggleAdvertisement = asyncHandler(async (req, res) => {
    const ticketId = parseObjectId(req.params.id, "ticket id");
    const { isAdvertised } = req.body || {};

    if (typeof isAdvertised !== "boolean") {
        throw ApiError.badRequest("isAdvertised must be a boolean.");
    }

    const ticket = await findTicketById(ticketId);

    if (!ticket) {
        throw ApiError.notFound("Ticket not found.");
    }

    if (isAdvertised && ticket.verificationStatus !== "approved") {
        throw ApiError.badRequest("Only approved tickets can be advertised.");
    }

    if (isAdvertised) {
        const advertisedCount = await getCollection("tickets").countDocuments({
            isAdvertised: true,
            verificationStatus: "approved",
            _id: { $ne: ticketId },
        });

        if (advertisedCount >= MAX_ADVERTISED) {
            throw ApiError.conflict(
                `You can advertise at most ${MAX_ADVERTISED} tickets. Unadvertise one first.`
            );
        }
    }

    await getCollection("tickets").updateOne(
        { _id: ticketId },
        { $set: { isAdvertised, updatedAt: new Date() } }
    );

    res.json({
        message: isAdvertised ? "Ticket is now advertised." : "Advertisement removed.",
        isAdvertised,
        remainingSlots: MAX_ADVERTISED,
    });
});

/** Distinct origins and destinations used to populate the search inputs. */
const getLocations = asyncHandler(async (_req, res) => {
    const tickets = getCollection("tickets");
    const visible = { verificationStatus: "approved", isHidden: { $ne: true } };

    // collection.distinct() is unavailable under Server API v1, so the values
    // are grouped in an aggregation instead.
    const [from, to] = await Promise.all([
        tickets
            .aggregate([{ $match: visible }, { $group: { _id: "$from" } }])
            .toArray(),
        tickets
            .aggregate([{ $match: visible }, { $group: { _id: "$to" } }])
            .toArray(),
    ]);

    res.json({
        from: from.map((row) => row._id).filter(Boolean).sort(),
        to: to.map((row) => row._id).filter(Boolean).sort(),
    });
});

const getTransportTypes = asyncHandler(async (_req, res) => {
    const { TRANSPORT_TYPES } = require("../models/ticket.model");

    res.json(TRANSPORT_TYPES);
});

module.exports = {
    getTickets,
    getAdvertisedTickets,
    getTicketById,
    getTicketsForAdmin,
    getMyTickets,
    createTicket,
    updateTicket,
    deleteTicket,
    moderateTicket,
    toggleAdvertisement,
    getLocations,
    getTransportTypes,
    buildTicketQuery,
};
