"""Connect, harvest nearby logs once, then disconnect."""

import argparse
import asyncio

from minebot import MineflayerBot


async def run(*, viewer_demo: bool = False) -> None:
    async with MineflayerBot(viewer_demo=viewer_demo) as bot:
        async for event in bot.events():
            if event.name == "connecting":
                print(f"서버 연결 중: {event.data['host']}:{event.data['port']}")
            elif event.name == "spawn":
                print("월드 입장 완료")
                await bot.chat("근처 나무를 찾습니다.")
                await bot.harvest_logs(count=8, max_distance=32)
            elif event.name == "viewer_started":
                print(f"3D 뷰어: {event.data['url']}")
                if viewer_demo:
                    print("오프라인 데모입니다. Minecraft 서버에 연결하지 않습니다. 종료: Ctrl+C")
            elif event.name == "harvest_target":
                print(f"나무 발견: {event.data['block']} @ {event.data['position']}")
            elif event.name == "harvest_progress":
                print(f"채집 진행: {event.data['mined']}/{event.data['requested']}")
            elif event.name == "harvest_complete":
                reason = event.data["reason"]
                mined = event.data["mined"]

                if reason == "no_natural_tree_found":
                    message = "근처에 나무가 없습니다."
                elif reason == "no_more_logs_found":
                    message = f"근처에 나무가 더 없습니다. 원목 {mined}개를 캤습니다."
                elif reason == "tree_unreachable":
                    message = "나무는 있지만 갈 수 없습니다."
                else:
                    message = f"나무 캐기 완료: 원목 {mined}개"

                print(message)
                await bot.chat(message)
                await asyncio.sleep(100)
                return
            elif event.name == "harvest_error":
                message = f"나무 캐기 실패: {event.data['message']}"
                print(message)
                await bot.chat(message)
                return
            elif event.name in {"error", "kicked", "end", "viewer_error", "bridge_stderr"}:
                print(f"[{event.name}] {event.data}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="나무 캐기 봇 / 오프라인 뷰어 검사")
    parser.add_argument("--viewer-demo", action="store_true", help="서버 없이 샘플 월드로 뷰어 실행")
    args = parser.parse_args()
    try:
        asyncio.run(run(viewer_demo=args.viewer_demo))
    except KeyboardInterrupt:
        print("\n봇을 종료했습니다.")
