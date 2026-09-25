import "dotenv/config";
import { env } from "./config/env";
import { dbConnect } from "./config/mongo";
import { createApp } from "./app";
import { seedAdmin } from "./services/auth.service";

async function main() {
  await dbConnect();
  await seedAdmin();

  const { server } = createApp();

  server.timeout = 10 * 60 * 1000;

  server.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });
}

main();
