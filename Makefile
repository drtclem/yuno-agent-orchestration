.PHONY: up down logs reset

up:
	@sh scripts/setup.sh
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs --follow

reset:
	@sh scripts/reset.sh
