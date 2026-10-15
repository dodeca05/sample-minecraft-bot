# 간단한 Minecraft 나무 캐기 봇

Python이 Mineflayer를 제어하고 `prismarine-viewer`로 봇 화면을 보여주는 예제입니다.

- 서버: `192.168.50.210:25565`
- Minecraft: `26.1.2`
- Node.js: 22 이상
- Python: 3.10 이상

## 설치 및 실행

```bash
node --version  # v22 이상
npm ci
python3 main.py
```

실행하면 봇이 자동으로 접속해 반경 32블록 안에서 나뭇잎이 붙은 자연 나무를 찾고 원목 8개를 캡니다. 작업이 끝나면 결과를 채팅으로 알리고, 화면 확인용 대기 시간 100초 후 접속을 종료합니다.

- 나무가 없으면 `근처에 나무가 없습니다.`라고 채팅하고 작업 종료
- 나무에 갈 수 없으면 `나무는 있지만 갈 수 없습니다.`라고 채팅하고 작업 종료
- 이동 중 지형이나 건축물은 캐지 않음

봇 화면은 [http://localhost:3007](http://localhost:3007)에서 확인합니다. 나무와 지형을 봇 시점으로 보여주는 3D 화면이며, Minecraft 게임의 인벤토리나 채팅 UI까지 복제하지는 않습니다. 종료는 `Ctrl+C`입니다. 봇 프로그램이 끝나면 로컬 뷰어 서버도 종료됩니다. 실제 접속 모드에서는 월드에 입장해야 뷰어가 시작됩니다.

## Minecraft 서버가 꺼져 있을 때 화면 확인

```bash
python3 main.py --viewer-demo
```

[http://localhost:3007](http://localhost:3007)을 열면 나무·풀밭·제작대가 있는 샘플 월드를 표시합니다. **실제 서버에 연결하거나 이전 서버 월드를 재생하지 않습니다.** 이 모드는 `Ctrl+C`까지 유지됩니다.

설치된 `prismarine-viewer 1.33.0`은 `26.1.2`를 직접 렌더링하지 못합니다. 봇은 `26.1.2`로 접속하되, 뷰어에 보낼 때만 블록 이름·속성 및 바이옴을 `1.21.4` 표시 형식으로 변환합니다. 새 버전에만 있는 블록은 자홍색 블록으로 대체 표시되며 봇의 실제 월드에는 영향을 주지 않습니다.

`bridge/viewer-assets.js`는 고정된 뷰어 번들의 높이 처리 오류를 메모리에서 보정합니다. `node_modules` 파일은 수정하지 않습니다. 뷰어 버전을 올릴 때는 이 보정과 `npm test`를 함께 확인해야 합니다.

화면에 오류가 나면 상단 안내를 확인하세요. `EADDRINUSE`는 3007 포트를 다른 프로세스가 사용 중이라는 뜻입니다. `.env`의 `VIEWER_PORT`를 바꾸면 됩니다. 뷰어는 이 컴퓨터의 localhost에서만 접근할 수 있습니다.

접속 설정은 `.env`에 있습니다.

```dotenv
MINECRAFT_HOST=192.168.50.210
MINECRAFT_PORT=25565
MINECRAFT_USERNAME=python_bot
MINECRAFT_AUTH=offline
MINECRAFT_VERSION=26.1.2
```

문법 검사:

```bash
npm run check
npm test
python3 -m py_compile main.py minebot/*.py
```
