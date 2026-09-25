const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
app.use(express.json());

app.use(
    cors({
        origin: process.env.CLIENT_URL,
    })
);

const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;
const authBaseUrl =
    process.env.AUTH_BASE_URL || process.env.CLIENT_URL;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        // Connect to MongoDB
        await client.connect();

        if (!authBaseUrl) {
            throw new Error(
                "Set AUTH_BASE_URL to the Next.js app URL so JWTs can be verified."
            );
        }

        // JWT / Better Auth
        const { createRemoteJWKSet, jwtVerify } = await import("jose");

        const jwks = createRemoteJWKSet(
            new URL(`${authBaseUrl}/api/auth/jwks`)
        );


        const requireAuth = async (req, res, next) => {
            const token =
                req.headers.authorization?.match(
                    /^Bearer\s+(.+)$/i
                )?.[1];

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

                // payload contains things like:
                // id, email, role
                req.user = payload;

                next();
            } catch (error) {
                console.error(
                    "JWT verification failed:",
                    error.message
                );

                return res.status(401).json({
                    message: "Your session is invalid or has expired.",
                });
            }
        };


        const requireRole = (...roles) => {
            return (req, res, next) => {
                if (!roles.includes(req.user?.role)) {
                    return res.status(403).json({
                        message:
                            "You do not have permission to perform this action.",
                    });
                }

                next();
            };
        };

        // Test MongoDB connection
        await client.db("admin").command({ ping: 1 });

        console.log("Successfully connected to MongoDB!");

        // Any authenticated user
        app.get("/me", requireAuth, (req, res) => {
            res.json({
                user: req.user,
            });
        });

        // Vendor only
        app.get(
            "/vendor/me",
            requireAuth,
            requireRole("vendor"),
            (req, res) => {
                res.json({
                    user: req.user,
                });
            }
        );

        // Admin only
        app.get(
            "/admin/me",
            requireAuth,
            requireRole("admin"),
            (req, res) => {
                res.json({
                    user: req.user,
                });
            }
        );


        // Get all tickets
        app.get("/tickets", async (req, res) => {
            try {
                const db = client.db("routely");
                const collection = db.collection("tickets");

                const { isAdvertised } = req.query;

                const query = {};

                if (isAdvertised !== undefined) {
                    query.isAdvertised = isAdvertised === "true";
                }

                const tickets = await collection
                    .find(query)
                    .toArray();

                res.json(tickets);
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    message: "Failed to fetch tickets",
                });
            }
        });

        // Get single ticket
        app.get("/tickets/:id", async (req, res) => {
            try {
                const db = client.db("routely");
                const collection = db.collection("tickets");

                const { id } = req.params;

                // Validate ObjectId
                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({
                        message: "Invalid ticket ID",
                    });
                }

                const ticket = await collection.findOne({
                    _id: new ObjectId(id),
                });

                if (!ticket) {
                    return res.status(404).json({
                        message: "Ticket not found",
                    });
                }

                res.json(ticket);
            } catch (error) {
                console.error(error);

                res.status(500).json({
                    message: "Failed to fetch ticket",
                });
            }
        });

        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });
    } catch (error) {
        console.error("Server startup failed:", error);
    }
}

run();
