import { Link } from "react-router";
import { inviteErrorMessage } from "./invite-http";
import { RoomRequestError } from "./room-http";

export function InviteError({ error, retry, retrying = false }: { error: unknown; retry?: () => void; retrying?: boolean }) {
  const sessionRequired = error instanceof RoomRequestError && ["SESSION_REQUIRED", "SESSION_EXPIRED", "UNAUTHORIZED"].includes(error.code);
  return <div className="room-query-error">
    <p className="form-message" role="alert">{inviteErrorMessage(error)}</p>
    {sessionRequired && <Link className="text-link" to="/login">重新登录</Link>}
    {retry && <button className="secondary-button" type="button" disabled={retrying} onClick={retry}>{retrying ? "读取中…" : "重新读取"}</button>}
  </div>;
}
