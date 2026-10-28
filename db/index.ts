// The deployed application uses local SQLite on the persistent ECS data volume.
// Route handlers use the async prepare/bind wrapper from lib/server.
export { getDatabase as getDb } from '../lib/runtime';
