import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

const InviteContext = createContext<{
  code: string;
  setCode: (code: string) => void;
  returningToJoin: boolean;
  setReturningToJoin: (returning: boolean) => void;
} | null>(null);

export function InviteProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState("");
  const [returningToJoin, setReturningToJoin] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!["/join", "/login", "/register"].includes(pathname)) {
      setCode("");
      setReturningToJoin(false);
    }
  }, [pathname]);
  return <InviteContext.Provider value={{ code, setCode, returningToJoin, setReturningToJoin }}>{children}</InviteContext.Provider>;
}

export function useInviteContext() {
  const context = useContext(InviteContext);
  if (!context) throw new Error("InviteProvider is required");
  return context;
}

// Capture and remove the fragment before the authentication gate can navigate away.
export function JoinEntry({ children }: { children: ReactNode }) {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const { setCode, returningToJoin, setReturningToJoin } = useInviteContext();
  useEffect(() => {
    setReturningToJoin(true);
    if (hash) {
      setCode(hash.slice(1));
      navigate("/join", { replace: true });
    }
  }, [hash, navigate, setCode, setReturningToJoin]);
  if (hash || !returningToJoin) return <p role="status">正在打开邀请…</p>;
  return children;
}
