import { useEffect, useRef, useState } from "react";
import { createMonitorSocket } from "../api/client";

const MONITOR_SOCKET_RECONNECT_BASE_MS = 1_000;
const MONITOR_SOCKET_RECONNECT_MAX_MS = 30_000;

export function useMonitorSocket(onMessage: (event: unknown) => void) {
  const callbackRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    callbackRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    stoppedRef.current = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (stoppedRef.current || reconnectTimerRef.current !== null) {
        return;
      }

      const delay = Math.min(
        MONITOR_SOCKET_RECONNECT_MAX_MS,
        MONITOR_SOCKET_RECONNECT_BASE_MS * 2 ** reconnectAttemptsRef.current
      );
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (stoppedRef.current) {
        return;
      }

      const socket = createMonitorSocket((event) => callbackRef.current(event));
      socketRef.current = socket;

      socket.onopen = () => {
        if (stoppedRef.current) {
          socket.close();
          return;
        }
        reconnectAttemptsRef.current = 0;
        setConnected(true);
      };

      socket.onerror = () => {
        if (!stoppedRef.current) {
          setConnected(false);
        }
        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      };

      socket.onclose = () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
        }
        if (!stoppedRef.current) {
          setConnected(false);
          scheduleReconnect();
        }
      };
    };

    connect();

    return () => {
      stoppedRef.current = true;
      clearReconnectTimer();
      setConnected(false);

      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, []);

  return connected;
}
