import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { roomName, roomNickname, roomShellView } from "../shared/room-contracts";
import { errorMessage, request, RoomRequestError } from "./room-http";
import { invalidateRoomIdentity } from "./room-identity-queries";

export function IdentityForm({ sessionId, roomId, field, current, disabledReason }: {
  sessionId: string; roomId: string; field: "name" | "nickname"; current: string; disabledReason?: string;
}) {
  const client = useQueryClient();
  const [input, setInput] = useState(current);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [command, setCommand] = useState<{ idempotencyKey: string; value: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setInput(current); }, [current]);
  const mutation = useMutation({
    mutationFn: (value: { idempotencyKey: string; value: string }) => {
      controller.current = new AbortController();
      return request(`/${roomId}/${field}`, roomShellView, controller.current.signal, { idempotencyKey: value.idempotencyKey, [field]: value.value });
    },
    retry: false,
    onSuccess: view => {
      if (controller.current?.signal.aborted) return;
      client.setQueryData(["room-shell", sessionId, roomId], view);
      void invalidateRoomIdentity(client, sessionId, roomId);
      setCommand(null);
      setInput(view.room[field]);
      setSaved(true);
      setMessage(field === "name" ? "房间名称已更新。" : "我的房间昵称已更新。");
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      setSaved(false);
      setMessage(errorMessage(failure));
      if (failure instanceof RoomRequestError) {
        setCommand(null);
        void invalidateRoomIdentity(client, sessionId, roomId);
      }
    }
  });
  const label = field === "name" ? "房间名称" : "我的房间昵称";
  return <form className="room-create-form settings-card" onSubmit={event => {
    event.preventDefault();
    if (mutation.isPending || disabledReason) return;
    const parsed = (field === "name" ? roomName : roomNickname).safeParse(input);
    setSaved(false);
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? "请检查输入。"); return; }
    const next = command?.value === parsed.data ? command : { idempotencyKey: uuidv7(), value: parsed.data };
    setCommand(next);
    setMessage("");
    mutation.mutate(next);
  }}>
    <label>{label}<input value={input} disabled={mutation.isPending || !!disabledReason} onChange={event => { setInput(event.target.value); setMessage(""); }} autoComplete="off" /></label>
    {disabledReason && <p className="field-help">{errorMessage(new RoomRequestError(disabledReason))}</p>}
    <button className="primary-button" type="submit" disabled={mutation.isPending || !!disabledReason}>{mutation.isPending ? "保存中…" : field === "name" ? "保存房间名称" : "保存我的昵称"}</button>
    {message && <p className={saved ? "netease-status" : "form-message"} role={saved ? "status" : "alert"}>{message}</p>}
  </form>;
}
