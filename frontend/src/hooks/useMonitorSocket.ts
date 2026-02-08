import { useEffect, useRef, useState } from "react";
import { createMonitorSocket } from "../api/client";

export function useMonitorSocket(onMessage: (event: unknown) => void) {
  const callbackRef = useRef(onMessage);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    callbackRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const socket = createMonitorSocket((event) => callbackRef.current(event));
    socket.onopen = () => setConnected(true);
    socket.onerror = () => setConnected(false);
    socket.onclose = () => setConnected(false);
    return () => {
      setConnected(false);
      socket.close();
    };
  }, []);

  return connected;
}
