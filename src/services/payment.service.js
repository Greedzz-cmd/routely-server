const crypto = require("crypto");

const { env } = require("../config/env");
const ApiError = require("../utils/ApiError");

let stripeClient;

/** Lazily constructs the Stripe SDK so mock mode never needs the dependency loaded. */
const getStripe = () => {
    if (stripeClient) {
        return stripeClient;
    }

    // Required lazily to keep the mock path free of Stripe's startup cost.
    const Stripe = require("stripe");

    stripeClient = new Stripe(env.payments.secretKey);

    return stripeClient;
};

const ZERO_DECIMAL_CURRENCIES = new Set([
    "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
    "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/**
 * Converts a whole-unit amount (e.g. 850 BDT) into the smallest currency unit
 * Stripe expects. BDT uses two decimals, so 850 BDT becomes 85000 poisha.
 */
const toMinorUnits = (amount, currency = env.payments.currency) => {
    const value = Number(amount) || 0;

    return ZERO_DECIMAL_CURRENCIES.has(currency)
        ? Math.round(value)
        : Math.round(value * 100);
};

/**
 * Creates a Checkout session for a booking.
 *
 * In mock mode no Stripe call is made: a deterministic fake session is returned
 * so the entire booking and payment flow stays testable without live keys.
 */
const createCheckoutSession = async ({ booking, user }) => {
    const amount = toMinorUnits(booking.totalPrice);

    if (env.payments.isMock) {
        const sessionId = `cs_mock_${crypto.randomBytes(12).toString("hex")}`;

        return {
            sessionId,
            url: `${env.payments.successUrl}&session_id=${sessionId}`,
            mock: true,
            amount,
        };
    }

    const session = await getStripe().checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: user.email,
        client_reference_id: String(booking._id),
        metadata: {
            bookingId: String(booking._id),
            pnr: booking.pnr,
            userId: String(user.id),
            userEmail: user.email,
            ticketTitle: booking.ticketTitle,
            quantity: String(booking.quantity),
        },
        line_items: [
            {
                quantity: 1,
                price_data: {
                    currency: env.payments.currency,
                    unit_amount: amount,
                    product_data: {
                        name: `${booking.ticketTitle} (${booking.from} to ${booking.to})`,
                        description: `${booking.quantity} seat(s) - PNR ${booking.pnr}`,
                        ...(booking.image ? { images: [booking.image] } : {}),
                    },
                },
            },
        ],
        success_url: env.payments.successUrl,
        cancel_url: env.payments.cancelUrl,
    });

    return { sessionId: session.id, url: session.url, mock: false, amount };
};

/** Verifies a Stripe webhook signature and returns the parsed event. */
const constructWebhookEvent = (payload, signature) => {
    if (env.payments.isMock) {
        return JSON.parse(payload.toString("utf8"));
    }

    if (!signature) {
        throw ApiError.badRequest("Missing stripe-signature header.");
    }

    try {
        return getStripe().webhooks.constructEvent(
            payload,
            signature,
            env.payments.webhookSecret
        );
    } catch (error) {
        throw ApiError.badRequest(`Webhook signature verification failed: ${error.message}`);
    }
};

const retrieveSession = (sessionId) => {
    if (env.payments.isMock) {
        return Promise.resolve({ id: sessionId, payment_status: "paid" });
    }

    return getStripe().checkout.sessions.retrieve(sessionId);
};

module.exports = {
    toMinorUnits,
    createCheckoutSession,
    constructWebhookEvent,
    retrieveSession,
    isMock: env.payments.isMock,
};
