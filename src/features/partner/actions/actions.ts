"use server";

import { db, dbNode } from "@/drizzle/db";
import { AgentTable, OrderStatusTable, OrderTable } from "@/drizzle/schema";
import { getCurrentUser } from "@/services/next-auth/lib/getCurrentAuth";
import { eq, and, isNull } from "drizzle-orm/sql";
import { eventBus } from "@/lib/event-bus"; // 1. Import your EventBus

export async function assignOrderToSelf(orderId: string) {
  const { userId } = await getCurrentUser();
  if (!userId) return { error: true, message: "Not Authenticated" };

  const agent = await getAgent(userId);
  if (!agent) return { error: true, message: "Not Authorized" };

  const result = await dbNode.transaction(async (tx) => {
    const order = await tx
      .select({ agentId: OrderTable.agentId })
      .from(OrderTable)
      .where(and(eq(OrderTable.id, orderId), isNull(OrderTable.agentId)))
      .for("update");

    if (!order || order.length === 0)
      return {
        error: true,
        message: "Invalid Order ID OR Order Already Taken",
      };

    await tx
      .update(OrderTable)
      .set({
        agentId: agent.id,
        currentStatus: "assigned",
      })
      .where(eq(OrderTable.id, orderId));

    return { error: false, message: "Order Accepted Successfully" };
  });

  // 2. Emit event if successful
  if (!result.error) {
    eventBus.emit(`order:${orderId}`, { status: "assigned" });
    eventBus.emit("dashboard:available:update", {
      type: "REMOVE",
      message: "A new order is available in your area!",
      timestamp: new Date().toISOString(),
    });
  }

  return result;
}

export async function updateOrderStatus(
  orderId: string,
  nextStatus: "picked" | "delivered"
) {
  const { userId } = await getCurrentUser();
  if (!userId) return { error: true, message: "Not Authenticated" };

  // 1. Verify agent
  const agent = await db.query.AgentTable.findFirst({
    where: eq(AgentTable.userId, userId),
    columns: { id: true },
  });

  if (!agent) {
    return { error: true, message: "Not Authorized as Delivery Agent" };
  }

  // 2. Read order (authorization + current state)
  const order = await db.query.OrderTable.findFirst({
    where: and(eq(OrderTable.id, orderId), eq(OrderTable.agentId, agent.id)),
    columns: { id: true, currentStatus: true },
  });

  if (!order) {
    return { error: true, message: "Order not found" };
  }

  // 3. Flow validation (business rule)
  const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    assigned: ["picked"],
    picked: ["delivered"],
  };

  const validNextStatuses = ALLOWED_TRANSITIONS[order.currentStatus] ?? [];

  if (!validNextStatuses.includes(nextStatus)) {
    return {
      error: true,
      message: `Cannot change from ${order.currentStatus} to ${nextStatus}`,
    };
  }

  try {
    // 4. Conditional update (optimistic concurrency control)
    const updated = await db
      .update(OrderTable)
      .set({ currentStatus: nextStatus })
      .where(
        and(
          eq(OrderTable.id, orderId),
          eq(OrderTable.currentStatus, order.currentStatus) // IMPORTANT
        )
      )
      .returning();

    // If no rows updated → status changed concurrently
    if (updated.length === 0) {
      return {
        error: true,
        message: "Order status was updated by another process",
      };
    }

    // 5. Best-effort status history insert
    await db.insert(OrderStatusTable).values({
      orderId,
      status: nextStatus,
    });

    // 6. Emit SSE event AFTER DB success
    eventBus.emit(`order:${orderId}`, {
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });

    return { error: false, message: "Order status updated successfully" };
  } catch (error) {
    console.error("Update Status Error:", error);
    return { error: true, message: "Failed to update order status" };
  }
}

async function getAgent(userId: string) {
  return await db.query.AgentTable.findFirst({
    where: eq(AgentTable.userId, userId),
    columns: { id: true },
  });
}
