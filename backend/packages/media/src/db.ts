import mysql from "mysql2/promise";
import { env } from "./env.js";

export const pool = mysql.createPool({
  uri: env.MEDIA_DATABASE_URL,
  connectionLimit: 10,
  namedPlaceholders: true,
});

export async function q<T = any>(
  sql: string,
  params: Record<string, any> = {},
): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}
