-- Purchases from Kiwify/Hotmart, applied to the account with the buyer's email.
-- event_key makes webhook retries idempotent. Rows with user_id NULL wait for
-- the buyer to sign up with that email and are claimed then.
CREATE TABLE IF NOT EXISTS external_checkout_purchases (
    event_key VARCHAR(255) PRIMARY KEY,
    provider VARCHAR(20) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    email VARCHAR(320) NOT NULL,
    action VARCHAR(20) NOT NULL,
    billing_interval VARCHAR(10),
    paid_until TIMESTAMP WITH TIME ZONE,
    user_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_external_checkout_purchases_email
    ON external_checkout_purchases (lower(email), created_at);
