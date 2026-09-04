from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Any, AsyncIterator


class BotCommandError(RuntimeError):
    """Raised when Mineflayer rejects a command from Python."""


@dataclass(frozen=True, slots=True)
class BotEvent:
    name: str
    data: dict[str, Any]

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "BotEvent":
        data = dict(message)
        name = str(data.pop("event", "unknown"))
        return cls(name=name, data=data)


def load_env_file(path: Path) -> dict[str, str]:
    """Read a small dotenv-style file without adding a Python dependency."""

    values: dict[str, str] = {}
    if not path.exists():
        return values

    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"{path}:{line_number}: expected KEY=VALUE")

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            raise ValueError(f"{path}:{line_number}: environment key is empty")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value

    return values


class MineflayerBot:
    def __init__(self) -> None:
        self.project_dir = Path(__file__).resolve().parent.parent
        self._process: asyncio.subprocess.Process | None = None
        self._events: asyncio.Queue[BotEvent] = asyncio.Queue()
        self._pending: dict[int, asyncio.Future[Any]] = {}
        self._ids = count(1)
        self._write_lock = asyncio.Lock()
        self._reader_tasks: list[asyncio.Task[None]] = []

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> "MineflayerBot":
        if self.running:
            return self

        bridge = self.project_dir / "bridge" / "index.js"
        if not bridge.exists():
            raise FileNotFoundError(f"Mineflayer bridge not found: {bridge}")

        child_env = load_env_file(self.project_dir / ".env")
        child_env.update(os.environ)
        node_executable = child_env.get("NODE_EXECUTABLE") or "node"

        self._process = await asyncio.create_subprocess_exec(
            node_executable,
            str(bridge),
            cwd=self.project_dir,
            env=child_env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_tasks = [
            asyncio.create_task(self._read_stdout(), name="mineflayer-stdout"),
            asyncio.create_task(self._read_stderr(), name="mineflayer-stderr"),
        ]
        return self

    async def _read_stdout(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        async for raw_line in self._process.stdout:
            line = raw_line.decode("utf-8", errors="replace").rstrip()
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                await self._events.put(BotEvent("bridge_log", {"message": line}))
                continue

            event = BotEvent.from_message(message)
            if event.name == "command_result":
                command_id = event.data.get("id")
                pending = self._pending.pop(command_id, None)
                if pending is not None and not pending.done():
                    if event.data.get("ok"):
                        pending.set_result(event.data.get("result"))
                    else:
                        pending.set_exception(BotCommandError(str(event.data.get("error"))))
                    continue

            await self._events.put(event)

        return_code = await self._process.wait()
        error = BotCommandError(f"Mineflayer bridge exited with code {return_code}")
        for future in self._pending.values():
            if not future.done():
                future.set_exception(error)
        self._pending.clear()
        await self._events.put(BotEvent("process_exit", {"returncode": return_code}))

    async def _read_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        async for raw_line in self._process.stderr:
            message = raw_line.decode("utf-8", errors="replace").rstrip()
            await self._events.put(BotEvent("bridge_stderr", {"message": message}))

    async def command(self, action: str, **payload: Any) -> Any:
        if not self.running or self._process is None or self._process.stdin is None:
            raise RuntimeError("The Mineflayer bridge is not running; call await bot.start() first")

        command_id = next(self._ids)
        loop = asyncio.get_running_loop()
        response: asyncio.Future[Any] = loop.create_future()
        self._pending[command_id] = response
        message = json.dumps({"id": command_id, "action": action, **payload}, ensure_ascii=False)

        try:
            async with self._write_lock:
                self._process.stdin.write((message + "\n").encode("utf-8"))
                await self._process.stdin.drain()
            return await asyncio.wait_for(response, timeout=10.0)
        except BaseException:
            self._pending.pop(command_id, None)
            raise

    async def chat(self, message: str) -> None:
        await self.command("chat", message=message)

    async def harvest_logs(self, count: int = 8, *, max_distance: int = 32) -> dict[str, Any]:
        """Start a background job that finds natural trees and mines their logs."""

        return await self.command("harvest_logs", count=count, maxDistance=max_distance)

    async def events(self) -> AsyncIterator[BotEvent]:
        while True:
            event = await self._events.get()
            yield event
            if event.name == "process_exit":
                break

    async def close(self) -> None:
        process = self._process
        if process is None:
            return

        if process.returncode is None:
            try:
                await self.command("quit", reason="Python controller stopped")
                await asyncio.wait_for(process.wait(), timeout=3.0)
            except (BotCommandError, BrokenPipeError, ConnectionResetError, asyncio.TimeoutError):
                if process.returncode is None:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=2.0)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()

        if self._reader_tasks:
            await asyncio.gather(*self._reader_tasks, return_exceptions=True)
        self._process = None

    async def __aenter__(self) -> "MineflayerBot":
        return await self.start()

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        await self.close()
