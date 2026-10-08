import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { roomName, roomNickname, roomShellView } from "../shared/room-contracts";
import { errorMessage, errorMessageForCode, request, RoomRequestError } from "./room-http";

const identityFields = {
  name: {
    schema: roomName,
    label: "房间名称",
    placeholder: "输入新的房间名称（1 到 16 个字符）",
    saved: "房间名称已更新。",
    button: "保存房间名称"
  },
  nickname: {
    schema: roomNickname,
    label: "我的房间昵称",
    placeholder: "输入你在房间内的新昵称（1 到 12 个字符）",
    saved: "我的房间昵称已更新。",
    button: "保存我的昵称"
  }
};

export function IdentityForm({ sessionId, roomId, field, current, disabledReason }: {
  sessionId: string; roomId: string; field: "name" | "nickname"; current: string; disabledReason?: string;
}) {
  const config = identityFields[field];
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
      void client.invalidateQueries({ queryKey: ["rooms", sessionId] });
      void client.invalidateQueries({ queryKey: ["room-invite", sessionId, roomId] });
      void client.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      void client.invalidateQueries({ queryKey: ["room-applications", sessionId, roomId] });
      setCommand(null);
      setInput(view.room[field]);
      setSaved(true);
      setMessage(config.saved);
    },
    onError: failure => {
      if (controller.current?.signal.aborted) return;
      setSaved(false);
      setMessage(errorMessage(failure));
      if (failure instanceof RoomRequestError) {
        setCommand(null);
        void client.invalidateQueries({ queryKey: ["room-shell", sessionId, roomId] });
        if (field === "nickname") void client.invalidateQueries({ queryKey: ["room-members", sessionId, roomId] });
      }
    }
  });
  return <form className="room-create-form settings-card" onSubmit={event => {
    event.preventDefault();
    if (mutation.isPending || disabledReason) return;
    const parsed = config.schema.safeParse(input);
    setSaved(false);
    if (!parsed.success) { setMessage(parsed.error.issues[0]?.message ?? "请检查输入。"); return; }
    const next = command?.value === parsed.data ? command : { idempotencyKey: uuidv7(), value: parsed.data };
    setCommand(next);
    setMessage("");
    mutation.mutate(next);
  }}>
    <label>
      {config.label}
      <input
        value={input}
        placeholder={config.placeholder}
        disabled={mutation.isPending || !!disabledReason}
        onChange={event => { setInput(event.target.value); setMessage(""); }}
        autoComplete="off"
      />
    </label>
    {disabledReason && <p className="field-help">{errorMessageForCode(disabledReason)}</p>}
    <button className="primary-button" type="submit" disabled={mutation.isPending || !!disabledReason}>{mutation.isPending ? "保存中…" : config.button}</button>
    {message && <p className={saved ? "netease-status" : "form-message"} role={saved ? "status" : "alert"}>{message}</p>}
  </form>;
}
