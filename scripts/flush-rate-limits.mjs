// Deletes every rate-limiter key (rl:*) from REDIS_URL so the integration
// suite can be re-run immediately (the login limiter otherwise 429s the
// second run). Dev/test only — refuses to touch a production Redis.
//   npm run test:reset
import dotenv from "dotenv";
import IORedis from "ioredis";

dotenv.config({ quiet: true });

if (process.env.NODE_ENV === "production") {
  console.error("❌ Refusing to flush rate limits with NODE_ENV=production");
  process.exit(1);
}

const redis = new IORedis(process.env.REDIS_URL);
let deleted = 0;
for await (const keys of redis.scanStream({ match: "rl:*", count: 500 })) {
  if (keys.length) deleted += await redis.del(...keys);
}
console.log(`🧹 Deleted ${deleted} rate-limit key(s)`);
await redis.quit();
