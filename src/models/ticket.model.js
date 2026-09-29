const { getCollection } = require("../config/db");
const ApiError = require("../utils/ApiError");

const TRANSPORT_TYPES = ["Bus", "Train", "Launch", "Flight"];
const FARE_CLASSES = ["Economy", "Business", "First", "Economy Plus"];
const VERIFICATION_STATUSES = ["pending", "approved", "rejected"];
const PERKS = [
    "AC",
    "Non-AC",
    "Breakfast",
    "Lunch",
    "WiFi",
    "Charging Port",
    "Reclining Seat",
    "TV",
    "Oxygen Support",
    "Wheelchair Access",
];

const SORT_OPTIONS = {
    "price-asc": { price: 1, createdAt: -1 },
    "price-desc": { price: -1, createdAt: -1 },
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    "departing-soon": { departureDateTime: 1 },
};

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 9;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const toNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** Normalises ?limit=abc or limit=999 into a safe 1..50 page size. */
const resolvePageSize = (value) => {
    const parsed = toNumber(value);
    return Math.min(Math.max(Math.trunc(parsed || DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
};

const resolvePage = (value) => Math.max(Math.trunc(toNumber(value) || 1), 1);

/**
 * Builds the Mongo filter for the All Tickets page.
 *
 * Only admin approved tickets are ever returned publicly, and tickets hidden
 * because their vendor was marked as fraud are excluded from every listing.
 */
const buildTicketQuery = ({
    from,
    to,
    transportType,
    fareClass,
    search,
    vendorEmail,
    vendorId,
    verificationStatus,
    isAdvertised,
    includeHidden = false,
} = {}) => {
    const query = {};

    if (verificationStatus) {
        query.verificationStatus = verificationStatus;
    } else {
        query.verificationStatus = "approved";
    }

    if (typeof isAdvertised === "boolean") {
        query.isAdvertised = isAdvertised;
    }

    if (!includeHidden) {
        query.isHidden = { $ne: true };
    }

    if (from) {
        query.from = { $regex: escapeRegExp(from.trim()), $options: "i" };
    }

    if (to) {
        query.to = { $regex: escapeRegExp(to.trim()), $options: "i" };
    }

    if (transportType && transportType.toLowerCase() !== "all") {
        query.transportType = {
            $regex: `^${escapeRegExp(transportType.trim())}$`,
            $options: "i",
        };
    }

    // Whitelisted rather than escaped: the catalogue only ever holds these
    // values, and an unknown label should mean "no filter" instead of a
    // guaranteed empty result.
    if (fareClass && fareClass.toLowerCase() !== "all") {
        const matched = FARE_CLASSES.find(
            (fare) => fare.toLowerCase() === fareClass.trim().toLowerCase()
        );

        if (matched) {
            query.fareClass = matched;
        }
    }

    if (search) {
        const term = escapeRegExp(search.trim());
        query.$or = [
            { title: { $regex: term, $options: "i" } },
            { from: { $regex: term, $options: "i" } },
            { to: { $regex: term, $options: "i" } },
            { operator: { $regex: term, $options: "i" } },
        ];
    }

    if (vendorEmail) {
        query.vendorEmail = { $regex: `^${escapeRegExp(vendorEmail.trim())}$`, $options: "i" };
    }

    if (vendorId) {
        query.vendorId = String(vendorId);
    }

    return query;
};

/** Runs a filtered, sorted and paginated ticket query. */
const listTickets = async ({
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
    sort = "newest",
    ...filters
} = {}) => {
    const tickets = getCollection("tickets");
    const query = buildTicketQuery(filters);
    const pageSize = resolvePageSize(limit);
    const currentPage = resolvePage(page);
    const sortSpec = SORT_OPTIONS[sort] || SORT_OPTIONS.newest;

    const [items, total] = await Promise.all([
        tickets
            .find(query)
            .sort(sortSpec)
            .skip((currentPage - 1) * pageSize)
            .limit(pageSize)
            .toArray(),
        tickets.countDocuments(query),
    ]);

    return {
        tickets: items,
        total,
        page: currentPage,
        limit: pageSize,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
};

const findTicketById = async (id) => getCollection("tickets").findOne({ _id: id });

const findTicketsByIds = async (ids) => {
    if (!ids.length) {
        return [];
    }

    const tickets = await getCollection("tickets")
        .find({ _id: { $in: ids } })
        .toArray();

    const byId = new Map(tickets.map((ticket) => [String(ticket._id), ticket]));

    return ids.map((id) => byId.get(String(id))).filter(Boolean);
};

const countTickets = (query = {}) => getCollection("tickets").countDocuments(query);

/** Validates and normalises the vendor supplied Add Ticket form. */
const validateTicketPayload = (body = {}, { requireFutureDeparture = true } = {}) => {
    const title = String(body.title || "").trim();
    const from = String(body.from || "").trim();
    const to = String(body.to || "").trim();
    const price = toNumber(body.price);
    const quantity = Number(body.quantity);
    const transportType = String(body.transportType || "Bus").trim();

    const errors = {};

    if (title.length < 3) {
        errors.title = "Title must be at least 3 characters.";
    }

    if (!from) {
        errors.from = "Origin is required.";
    }

    if (!to) {
        errors.to = "Destination is required.";
    }

    if (from && to && from.toLowerCase() === to.toLowerCase()) {
        errors.to = "Origin and destination must be different.";
    }

    if (price === null || price < 0) {
        errors.price = "Price must be zero or greater.";
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
        errors.quantity = "Quantity must be a whole number of at least 1.";
    }

    if (!TRANSPORT_TYPES.some((type) => type.toLowerCase() === transportType.toLowerCase())) {
        errors.transportType = `Transport type must be one of: ${TRANSPORT_TYPES.join(", ")}.`;
    }

    if (body.departureDateTime) {
        const departure = new Date(body.departureDateTime);

        if (Number.isNaN(departure.getTime())) {
            errors.departureDateTime = "Departure date and time is invalid.";
        } else if (requireFutureDeparture && departure.getTime() <= Date.now()) {
            errors.departureDateTime = "Departure must be in the future.";
        }
    } else {
        errors.departureDateTime = "Departure date and time is required.";
    }

    if (Object.keys(errors).length) {
        throw ApiError.badRequest("Please correct the highlighted fields.", errors);
    }

    const perks = Array.isArray(body.perks)
        ? body.perks.filter((perk) => typeof perk === "string" && perk.trim())
        : [];

    return {
        title,
        from,
        to,
        price,
        quantity,
        totalSeats: toNumber(body.totalSeats) || quantity,
        transportType: TRANSPORT_TYPES.find(
            (type) => type.toLowerCase() === transportType.toLowerCase()
        ),
        fareClass: String(body.fareClass || "Economy").trim(),
        departureDateTime: new Date(body.departureDateTime),
        arrivalDateTime: body.arrivalDateTime ? new Date(body.arrivalDateTime) : null,
        duration: String(body.duration || "").trim(),
        image: String(body.image || "").trim(),
        perks,
        operator: String(body.operator || "").trim() || null,
    };
};

module.exports = {
    TRANSPORT_TYPES,
    FARE_CLASSES,
    VERIFICATION_STATUSES,
    PERKS,
    SORT_OPTIONS,
    MAX_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
    buildTicketQuery,
    listTickets,
    findTicketById,
    findTicketsByIds,
    countTickets,
    validateTicketPayload,
    resolvePageSize,
    resolvePage,
    escapeRegExp,
    toNumber,
};
