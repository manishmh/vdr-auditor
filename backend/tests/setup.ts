// Runs before test modules are imported so importing src/app.js (which
// validates env at module top level) sees valid non-database config.
process.env["NODE_ENV"] ??= "test";
process.env["FRONTEND_ORIGIN"] ??= "http://localhost:3000";
delete process.env["MONGODB_URI"];
