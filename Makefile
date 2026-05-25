install:
	pnpm run build
	ln -sfnT $(PWD)/dist ${HOME}/.pi/agent/extensions/pi-claudify
	rsync -avp --delete  src/resource/ ./dist/resource/ --exclude light_chat
	cp package.json  ./dist/


test:
	curl --unix-socket /run/user/1000/pi-claudify.$(shell cat .pi/pi-claudify.pid)  -X POST http://localhost/ask-approval/native-diff \
		-d '{"path": "tmp", "newContent":"", "timeoutMs": 30000}'
