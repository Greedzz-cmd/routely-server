const express = require("express");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");

dotenv.config();

const app = express();

const port = process.env.PORT;
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        await client.connect();

        await client.db("admin").command({ ping: 1 });

        console.log("Successfully connected to MongoDB!");

        app.get("/", async (req, res) => {
            try {
                const db = client.db("ticket-bari");
                const collection = db.collection("tickets");

                const tickets = await collection.find().toArray();

                res.send(tickets);
            } catch (error) {
                console.error(error);
                res.status(500).send("Failed to fetch tickets");
            }
        });

        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
        });
    } catch (error) {
        console.error("MongoDB connection failed:", error);
    }
}

run();
