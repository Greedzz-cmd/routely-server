const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URI;
const clientUrl = process.env.CLIENT_URL;
const authBaseUrl = process.env.AUTH_BASE_URL || clientUrl;

app.use(express.json());

app.use(
    cors({
        origin: clientUrl,
    })
);

const mongoClient = new MongoClient(mongoUri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

let db;
let jwtVerify;
let jwks;

async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (!token) {
        return res.status(401).json({
            message: "A bearer token is required.",
        });
    }

    try {
        const { payload } = await jwtVerify(token, jwks, {
            issuer: authBaseUrl,
            audience: authBaseUrl,
        });

        req.user = payload;
        next();
    } catch (error) {
        console.error("JWT verification failed:", error.message);

        return res.status(401).json({
            message: "Your session is invalid or has expired.",
        });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return res.status(403).json({
                message: "You do not have permission to perform this action.",
            });
        }

        next();
    };
}

function validObjectId(value) {
    return typeof value === "string" && ObjectId.isValid(value);
}

async function startServer() {
    try {
        if (!mongoUri) {
            throw new Error("MONGODB_URI is missing.");
        }

        if (!authBaseUrl) {
            throw new Error("AUTH_BASE_URL or CLIENT_URL is missing.");
        }

        await mongoClient.connect();
        await mongoClient.db("admin").command({ ping: 1 });

        db = mongoClient.db("routely");

        const jose = await import("jose");

        jwtVerify = jose.jwtVerify;
        jwks = jose.createRemoteJWKSet(
            new URL(`${authBaseUrl}/api/auth/jwks`)
        );

        await db.collection("bookings").createIndex({ userId: 1 });
        await db.collection("bookings").createIndex({ vendorEmail: 1 });
        await db.collection("bookings").createIndex({ ticketId: 1 });

        console.log("Connected to MongoDB.");

        app.get("/", (req, res) => {
            res.json({ message: "Routely API is running." });
        });

        app.get("/me", requireAuth, (req, res) => {
            res.json({ user: req.user });
        });

        // ---------------------------------------------------------------------
        // Tickets
        // ---------------------------------------------------------------------

        app.get("/tickets", async (req, res) => {
            try {
                const query = {};

                if (req.query.isAdvertised !== undefined) {
                    query.isAdvertised = req.query.isAdvertised === "true";
                }

                const tickets = await db
                    .collection("tickets")
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.json(tickets);
            } catch (error) {
                console.error(error);
                res.status(500).json({ message: "Failed to fetch tickets." });
            }
        });

        app.get("/tickets/approved", async (req, res) => {
            try {
                const tickets = await db
                    .collection("tickets")
                    .find({ verificationStatus: "approved" })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.json(tickets);
            } catch (error) {
                console.error(error);
                res.status(500).json({
                    message: "Failed to fetch approved tickets.",
                });
            }
        });

        app.get("/tickets/:id", async (req, res) => {
            if (!validObjectId(req.params.id)) {
                return res.status(400).json({
                    message: "Invalid ticket ID.",
                });
            }

            try {
                const ticket = await db.collection("tickets").findOne({
                    _id: new ObjectId(req.params.id),
                });

                if (!ticket) {
                    return res.status(404).json({
                        message: "Ticket not found.",
                    });
                }

                res.json(ticket);
            } catch (error) {
                console.error(error);
                res.status(500).json({
                    message: "Failed to fetch ticket.",
                });
            }
        });

        app.post(
            "/tickets",
            requireAuth,
            requireRole("vendor"),
            async (req, res) => {
                const {
                    title,
                    from,
                    to,
                    price,
                    quantity,
                    totalSeats,
                    departureDateTime,
                    arrivalDateTime,
                    duration,
                    image,
                    transportType,
                    fareClass,
                    perks,
                } = req.body;

                const numericPrice = Number(price);
                const numericQuantity = Number(quantity);

                if (
                    !title ||
                    !from ||
                    !to ||
                    !Number.isFinite(numericPrice) ||
                    numericPrice < 0 ||
                    !Number.isInteger(numericQuantity) ||
                    numericQuantity < 1
                ) {
                    return res.status(400).json({
                        message: "Invalid ticket data.",
                    });
                }

                try {
                    const ticket = {
                        title,
                        from,
                        to,
                        price: numericPrice,
                        quantity: numericQuantity,
                        totalSeats: Number(totalSeats) || numericQuantity,
                        departureDateTime,
                        arrivalDateTime,
                        duration,
                        image,
                        transportType: transportType || "Bus",
                        fareClass: fareClass || "Economy",
                        perks: Array.isArray(perks) ? perks : [],
                        vendorId: String(req.user.id),
                        vendorName: req.user.name || req.user.email,
                        vendorEmail: req.user.email,
                        verificationStatus: "pending",
                        isAdvertised: false,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    };

                    const result = await db
                        .collection("tickets")
                        .insertOne(ticket);

                    res.status(201).json({
                        message: "Ticket created successfully.",
                        ticketId: result.insertedId,
                    });
                } catch (error) {
                    console.error(error);
                    res.status(500).json({
                        message: "Failed to create ticket.",
                    });
                }
            }
        );

        app.patch(
            "/tickets/:id",
            requireAuth,
            requireRole("vendor", "admin"),
            async (req, res) => {
                if (!validObjectId(req.params.id)) {
                    return res.status(400).json({
                        message: "Invalid ticket ID.",
                    });
                }

                const allowedFields = [
                    "title",
                    "from",
                    "to",
                    "price",
                    "quantity",
                    "departureDateTime",
                    "arrivalDateTime",
                    "duration",
                    "image",
                    "transportType",
                    "fareClass",
                    "perks",
                    "isAdvertised",
                    "verificationStatus",
                ];

                const updates = {};

                for (const field of allowedFields) {
                    if (req.body[field] !== undefined) {
                        updates[field] = req.body[field];
                    }
                }

                updates.updatedAt = new Date();

                try {
                    const result = await db.collection("tickets").updateOne(
                        { _id: new ObjectId(req.params.id) },
                        { $set: updates }
                    );

                    if (result.matchedCount === 0) {
                        return res.status(404).json({
                            message: "Ticket not found.",
                        });
                    }

                    res.json({ message: "Ticket updated successfully." });
                } catch (error) {
                    console.error(error);
                    res.status(500).json({
                        message: "Failed to update ticket.",
                    });
                }
            }
        );

        app.delete(
            "/tickets/:id",
            requireAuth,
            requireRole("vendor", "admin"),
            async (req, res) => {
                if (!validObjectId(req.params.id)) {
                    return res.status(400).json({
                        message: "Invalid ticket ID.",
                    });
                }

                try {
                    const result = await db.collection("tickets").deleteOne({
                        _id: new ObjectId(req.params.id),
                    });

                    if (result.deletedCount === 0) {
                        return res.status(404).json({
                            message: "Ticket not found.",
                        });
                    }

                    res.json({ message: "Ticket deleted successfully." });
                } catch (error) {
                    console.error(error);
                    res.status(500).json({
                        message: "Failed to delete ticket.",
                    });
                }
            }
        );

        // ---------------------------------------------------------------------
        // Bookings
        // ---------------------------------------------------------------------

        app.post("/bookings", requireAuth, async (req, res) => {
            const { ticketId, quantity } = req.body;
            const seats = Number(quantity);

            if (
                !validObjectId(ticketId) ||
                !Number.isInteger(seats) ||
                seats < 1
            ) {
                return res.status(400).json({
                    message: "Valid ticketId and quantity are required.",
                });
            }

            try {
                const ticket = await db.collection("tickets").findOneAndUpdate(
                    {
                        _id: new ObjectId(ticketId),
                        verificationStatus: "approved",
                        quantity: { $gte: seats },
                    },
                    {
                        $inc: { quantity: -seats },
                    },
                    {
                        returnDocument: "after",
                        includeResultMetadata: false,
                    }
                );

                if (!ticket) {
                    return res.status(409).json({
                        message:
                            "Ticket is unavailable or does not have enough seats.",
                    });
                }

                const user = validObjectId(req.user.id)
                    ? await db.collection("user").findOne(
                          { _id: new ObjectId(req.user.id) },
                          { projection: { name: 1, email: 1 } }
                      )
                    : null;

                const booking = {
                    pnr: `RLY-${crypto
                        .randomBytes(6)
                        .toString("hex")
                        .toUpperCase()}`,

                    userId: String(req.user.id),
                    userName: user?.name || req.user.email,
                    userEmail: req.user.email,

                    ticketId: ticket._id,
                    ticketTitle: ticket.title,
                    vendorId: ticket.vendorId || null,
                    vendorEmail: ticket.vendorEmail || null,

                    from: ticket.from,
                    to: ticket.to,
                    transportType: ticket.transportType || "Bus",
                    operator: ticket.vendorName || ticket.title,
                    image: ticket.image,
                    departureDateTime: ticket.departureDateTime,

                    quantity: seats,
                    pricePerSeat: Number(ticket.price),
                    totalPrice: seats * Number(ticket.price),

                    status: "pending",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                };

                try {
                    const result = await db
                        .collection("bookings")
                        .insertOne(booking);

                    res.status(201).json({
                        message: "Booking request submitted.",
                        bookingId: result.insertedId,
                        booking,
                    });
                } catch (error) {
                    await db.collection("tickets").updateOne(
                        { _id: ticket._id },
                        { $inc: { quantity: seats } }
                    );

                    throw error;
                }
            } catch (error) {
                console.error("Booking creation failed:", error);
                res.status(500).json({
                    message: "Failed to create booking.",
                });
            }
        });

        app.get("/bookings", requireAuth, async (req, res) => {
            try {
                const query =
                    req.user.role === "vendor"
                        ? { vendorEmail: req.user.email }
                        : { userId: String(req.user.id) };

                const bookings = await db
                    .collection("bookings")
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.json(bookings);
            } catch (error) {
                console.error(error);
                res.status(500).json({
                    message: "Failed to fetch bookings.",
                });
            }
        });

        app.patch(
            "/bookings/:id",
            requireAuth,
            requireRole("vendor"),
            async (req, res) => {
                const { status } = req.body;

                if (!["accepted", "rejected"].includes(status)) {
                    return res.status(400).json({
                        message: "Status must be accepted or rejected.",
                    });
                }

                if (!validObjectId(req.params.id)) {
                    return res.status(400).json({
                        message: "Invalid booking ID.",
                    });
                }

                try {
                    const booking =
                        await db.collection("bookings").findOneAndUpdate(
                            {
                                _id: new ObjectId(req.params.id),
                                vendorEmail: req.user.email,
                                status: "pending",
                            },
                            {
                                $set: {
                                    status,
                                    updatedAt: new Date(),
                                },
                            },
                            {
                                returnDocument: "after",
                                includeResultMetadata: false,
                            }
                        );

                    if (!booking) {
                        return res.status(404).json({
                            message: "Pending booking not found.",
                        });
                    }

                    if (status === "rejected") {
                        await db.collection("tickets").updateOne(
                            { _id: booking.ticketId },
                            { $inc: { quantity: booking.quantity } }
                        );
                    }

                    res.json({
                        message: `Booking ${status}.`,
                        booking,
                    });
                } catch (error) {
                    console.error(error);
                    res.status(500).json({
                        message: "Failed to update booking.",
                    });
                }
            }
        );

        // ---------------------------------------------------------------------
        // Vendors
        // ---------------------------------------------------------------------

        app.get("/vendors", async (req, res) => {
            try {
                const vendors = await db
                    .collection("user")
                    .find(
                        { role: "vendor" },
                        {
                            projection: {
                                name: 1,
                                email: 1,
                                role: 1,
                            },
                        }
                    )
                    .toArray();

                res.json(vendors);
            } catch (error) {
                console.error(error);
                res.status(500).json({
                    message: "Failed to fetch vendors.",
                });
            }
        });

        app.listen(port, () => {
            console.log(`Server running on port ${port}`);
        });
    } catch (error) {
        console.error("Server startup failed:", error);
        process.exit(1);
    }
}

startServer();