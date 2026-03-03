run-engine:
	cd engine && python main.py

run-gui:
	cd gui && npm run desktop:dev

test-engine:
	cd engine && pytest -q
