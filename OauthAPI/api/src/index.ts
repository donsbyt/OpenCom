import { buildHttp } from "./http.js";
import { env } from "./env.js";

const app = buildHttp();

app.listen({
  port: env.PORT,
  host: env.HOST,
}).then(() => {
  console.log(`Server running on port ${env.PORT}`);
}).catch((err) => {
  app.log.error(err);
  process.exit(1);
});