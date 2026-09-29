const { MongoClient, ServerApiVersion } = require("mongodb");

const { env } = require("./env");

const COLLECTIONS = {
    users: "user",
    tickets: "tickets",
    bookings: "bookings",
    transactions: "transactions",
};

let client;
let database;

/**
 * Opens the shared Mongo connection and the indexes the query layer relies on.
 * Re-entrant: repeated calls reuse the existing client.
 */
const connectDatabase = async () => {
    if (database) {
        return database;
    }

    client = new MongoClient(env.mongoUri, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        },
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });

    database = client.db(env.mongoDb);

    const { tickets, bookings, transactions, users } = COLLECTIONS;

    // Listing, filtering and sorting happen on the server, so these back the
    // most frequent reads on the All Tickets page.
    await database.collection(tickets).createIndex({ verificationStatus: 1, createdAt: -1 });
    await database.collection(tickets).createIndex({ isAdvertised: 1, verificationStatus: 1 });
    await database.collection(tickets).createIndex({ from: 1, to: 1, price: 1 });
    await database.collection(tickets).createIndex({ vendorEmail: 1, createdAt: -1 });
    await database.collection(tickets).createIndex({ transportType: 1 });

    await database.collection(bookings).createIndex({ userEmail: 1, createdAt: -1 });
    await database.collection(bookings).createIndex({ vendorEmail: 1, status: 1 });
    await database.collection(bookings).createIndex({ ticketId: 1 });

    await database.collection(transactions).createIndex({ userEmail: 1, paidAt: -1 });
    await database.collection(transactions).createIndex({ bookingId: 1 }, { unique: true });

    await database.collection(users).createIndex({ email: 1 }, { unique: true });
    await database.collection(users).createIndex({ role: 1, isFraud: 1 });

    console.log(`Connected to MongoDB database "${env.mongoDb}".`);

    return database;
};

const getDatabase = () => {
    if (!database) {
        throw new Error("Database accessed before connectDatabase() completed.");
    }

    return database;
};

const getCollection = (name) => getDatabase().collection(COLLECTIONS[name] || name);

const closeDatabase = async () => {
    if (client) {
        await client.close();
        client = undefined;
        database = undefined;
    }
};

module.exports = {
    COLLECTIONS,
    connectDatabase,
    closeDatabase,
    getDatabase,
    getCollection,
};
