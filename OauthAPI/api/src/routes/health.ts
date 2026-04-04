import type { FastifyInstance } from "fastify";

export function HealthRoutes(app: FastifyInstance) {
  app.get('/status', async (request, reply) => {
    return {
      success: true,
      message: 'Oauth API Healthy'
    };
  });


}