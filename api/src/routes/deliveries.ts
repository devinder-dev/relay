// Lists deliveries and reads one delivery after checking filters and ids.
import type { FastifyPluginAsync } from "fastify";
import type { Sql } from "../db.ts";
import { notFound, unauthorized } from "../errors.ts";
import { DeliveryId, DeliveryListQuery } from "../schemas/deliveries.ts";
import { getDelivery, listDeliveries } from "../services/deliveries.ts";

export const deliveryRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  // Step 1: query input uses public names; repository filters use local camelCase.
  app.get("/deliveries", async (request) => {
    if (!request.owner) throw unauthorized();
    const query = DeliveryListQuery.parse(request.query);
    return listDeliveries(sql, request.owner.id, {
      status: query.status, endpointId: query.endpoint_id, cursor: query.cursor, limit: query.limit,
    });
  });
  // Step 2: malformed ids have the same 404 as missing and foreign ids.
  app.get<{ Params: { id: string } }>("/deliveries/:id", async (request) => {
    if (!request.owner) throw unauthorized();
    const id = DeliveryId.safeParse(request.params.id);
    if (!id.success) throw notFound("Delivery");
    return getDelivery(sql, request.owner.id, id.data);
  });
};
