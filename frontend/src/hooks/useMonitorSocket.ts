import { useEffect, useRef } from "react";
import { createMonitorSocket } from "../api/client";

export function useMonitorSocket(onMessage: (event: unknown) => void) {
  const callbackRef = useRef(onMessage);

  useEffect(() => {
    callbackRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    const socket = createMonitorSocket((event) => callbackRef.current(event));
    return () => socket.close();
  }, []);
}
