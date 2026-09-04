# 간단한 Minecraft 나무 캐기 봇

Python이 Mineflayer를 제어하고 `prismarine-viewer`로 봇 화면을 보여주는 예제입니다.

- 서버: `192.168.50.210:25565`
- Minecraft: `26.1.2`
- Node.js: 22 이상
- Python: 3.10 이상

## 설치 및 실행

```bash
nvm use
npm install
python3 main.py
```

실행하면 봇이 자동으로 접속해 반경 32블록 안에서 나뭇잎이 붙은 자연 나무를 찾고 원목 8개를 캡니다. 작업이 끝나면 결과를 채팅으로 알리고 자동으로 접속을 종료합니다.

- 나무가 없으면 `근처에 나무가 없습니다.`라고 채팅하고 작업 종료
- 나무에 갈 수 없으면 `나무는 있지만 갈 수 없습니다.`라고 채팅하고 작업 종료
- 이동 중 지형이나 건축물은 캐지 않음

봇 화면은 [http://localhost:3007](http://localhost:3007)에서 확인합니다. 종료는 `Ctrl+C`입니다.

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
python3 -m py_compile main.py minebot/*.py
```
