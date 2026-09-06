# ============================================================================
# Makefile — безопасный деплой (v1.4.1).
#
# Проблема, которую решаем: в /opt/opengym (прод) и /opt/opengym-demo (демо)
# лежат одинаковые чекауты demo-ветки. Запуск демо-скриптов не из своего
# каталога молча использует ЧУЖОЙ .env — так в v1.4.0 контейнеры demo-стека
# были пересозданы с прод-окружением. Каждый таргет ниже жёстко проверяет,
# из какой директории его зовут, какую ветку и какой .env он видит.
#
# Куда что деплоится:
#   · ПРОД  gym.trfnv.ru      — /opt/opengym        (ветка demo, стек docker compose)
#   · ДЕМО  demo.gym.trfnv.ru — /opt/opengym-demo    (ветка demo, ./deploy-demo.sh)
#
# Использование:
#   make deploy-prod     # прод (gym.trfnv.ru), только из /opt/opengym
#   make deploy-demo     # демо (demo.gym.trfnv.ru), только из /opt/opengym-demo
#   make reset-demo      # сброс демо-стенда, только из /opt/opengym-demo
# ============================================================================

.PHONY: deploy-prod deploy-demo reset-demo guard-prod guard-demo

guard-prod:
	@test "$$(pwd)" = "/opt/opengym" || { echo "ОШИБКА: прод-деплой только из /opt/opengym (сейчас: $$(pwd))"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "demo" || { echo "ОШИБКА: ожидалась ветка demo (сейчас: $$(git rev-parse --abbrev-ref HEAD))"; exit 1; }
	@grep -q '^ORIGIN=https://gym.trfnv.ru' .env || { echo "ОШИБКА: .env не похож на прод (ORIGIN!=gym.trfnv.ru). Прервано."; exit 1; }

guard-demo:
	@test "$$(pwd)" = "/opt/opengym-demo" || { echo "ОШИБКА: демо-деплой только из /opt/opengym-demo (сейчас: $$(pwd))"; exit 1; }
	@test "$$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "demo" || { echo "ОШИБКА: ожидалась ветка demo"; exit 1; }
	@grep -q '^DEMO_MODE=1' .env || { echo "ОШИБКА: .env без DEMO_MODE=1 — это не демо-окружение"; exit 1; }

deploy-prod: guard-prod
	docker compose build api web
	docker compose up -d api web
	@echo "✓ Прод обновлён (gym.trfnv.ru). Проверка: curl -s https://gym.trfnv.ru/api/health"

deploy-demo: guard-demo
	./deploy-demo.sh

reset-demo: guard-demo
	./reset-demo.sh
