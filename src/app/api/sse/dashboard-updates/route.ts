import { eventBus } from "@/lib/event-bus";
import { NextRequest } from "next/server";
import { getCurrentUser } from "@/services/next-auth/lib/getCurrentAuth";

export async function GET(req: NextRequest) {
  // Secure: Only drivers can listen
  const { userId } = await getCurrentUser();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const onDashboardUpdate = (data: any) => {
        // Send a signal to the client
        const message = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(message));
      };

      // Listen to the global dashboard channel
      eventBus.on("dashboard:available:update", onDashboardUpdate);

      // Cleanup on connection close
      const cleanup = () => {
        eventBus.off("dashboard:available:update", onDashboardUpdate);
        controller.close();
      };

      req.signal.addEventListener("abort", cleanup);

      // Fallback timeout cleanup (prevent zombie connections)
      // If abort signal fails for any reason, force cleanup after 1 hour
      const timeoutId = setTimeout(() => {
        console.warn("[SSE] Force closing stale dashboard update connection");
        cleanup();
      }, 60 * 60 * 1000); // 1 hour

      // Make sure to clear timeout on normal cleanup
      const originalCleanup = cleanup;
      const wrappedCleanup = () => {
        clearTimeout(timeoutId);
        originalCleanup();
      };

      req.signal.removeEventListener("abort", cleanup);
      req.signal.addEventListener("abort", wrappedCleanup);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}