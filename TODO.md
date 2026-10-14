# FunStory Todo List

- [x] Design app architecture and choose stack (Flutter + Node)
- [x] Remove Python prototype files
- [x] Set up Node.js backend with Express and Wikipedia/LLM logic
- [x] Create Flutter frontend project and UI
- [x] Wire Flutter frontend to Node backend
- [x] Add configuration and run instructions
- [x] Test end-to-end with OpenRouter free model
- [x] Update Flutter default backend URL for production
- [x] Build Flutter web app
- [x] Create working nginx vhost for funstory.4ft.me (on server.4ft.me, proxies to 10.8.0.2:8765 over VPN)
- [x] Obtain SSL certificate via Certbot (valid until 2027-01-11)
- [x] Start Node backend and verify end-to-end (systemd user service `funstory.service`)
- [x] Persist generated stories + cache by Wikipedia slug (server/stories/*.json)
- [x] Shareable URLs at /s/<slug> with copy + regenerate buttons in the UI
- [x] Reader-focused UI redesign (serif typography, share links, further reading)
- [x] Per-IP rate limiting on LLM endpoints (20/hr public; LAN/VPN/bypass-key exempt)
