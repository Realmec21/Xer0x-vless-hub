# Xer0x-vless-hub

Автоматический сборник публичных VLESS-профилей: сканирует открытые источники, проверяет каждый профиль на работоспособность, измеряет задержку и скорость, определяет страну сервера, отслеживает uptime, и публикует подписки в нескольких форматах.

**Дашборд:** https://realmec21.github.io/Xer0x-vless-hub/

## Подписки

```
https://raw.githubusercontent.com/Realmec21/Xer0x-vless-hub/main/subscriptions/fast.txt
https://raw.githubusercontent.com/Realmec21/Xer0x-vless-hub/main/subscriptions/whitelist.txt
https://raw.githubusercontent.com/Realmec21/Xer0x-vless-hub/main/subscriptions/blacklist.txt
https://raw.githubusercontent.com/Realmec21/Xer0x-vless-hub/main/subscriptions/clash.yaml
https://raw.githubusercontent.com/Realmec21/Xer0x-vless-hub/main/subscriptions/sing-box.json
```

| Файл | Формат | Для чего |
|---|---|---|
| `fast.txt` | vless:// URI | Профили <300ms — самые быстрые |
| `whitelist.txt` | vless:// URI | Профили для белого списка (TLS, публичный сертификат) |
| `blacklist.txt` | vless:// URI | Остальные рабочие профили |
| `clash.yaml` | Clash | Clash / ClashMeta / mihomo (роутеры, OpenWrt) |
| `sing-box.json` | sing-box | Hiddify / Streisand / NekoBox / sing-box |

В клиенте (v2rayN / v2rayNG / NekoBox / Hiddify / Streisand / Clash): **Подписки → Добавить подписку** → вставить ссылку → Обновить.

## Имена профилей

`⚡ 🇺🇸 ~12Mbps Xer0x-01`

| Элемент | Значение |
|---|---|
| ⚡ / 🔵 / 🔴 | Задержка: <300ms / <500ms / ≥500ms |
| 🇺🇸 | Флаг страны сервера |
| ~12Mbps | Скорость (тест скачивания 2MB через прокси) |
| Xer0x-01 | Ник + номер (сортировка по задержке) |

## Как это работает

1. **Сбор** — качает списки из `config.json → sources`, вытаскивает `vless://` URI, удаляет дубликаты по параметрам и по эндпоинту `uuid@host:port`.
2. **Проверка** — поднимается изолированный xray-core (HTTP-прокси), через него выполняется запрос к Cloudflare trace. Профиль жив, если пришёл ответ. Измеряется задержка.
3. **Скорость** — через живой прокси качается 2MB с speed.cloudflare.com, считается Mbps.
4. **Гео** — IP сервера определяется по ip-api.com, в имя подставляется флаг страны.
5. **Uptime** — каждый прогон записывается в историю; профили с uptime ≥80% приоритизируются; мёртвые не удаляются сразу (3 прогона на восстановление).
6. **Классификация** — whitelist (TLS + публичный сертификат + задержка) vs blacklist vs fast (<300ms).
7. **Сборка** — генерируются все 5 подписок + report.json.

### Критерии белого списка (`config.json → whitelist`)

| Критерий | Смысл | По умолчанию |
|---|---|---|
| `requirePublicTls` | TLS с публичным доверенным сертификатом | `true` |
| `requireDomain` | Сервер — домен, а не IP | `false` |
| `requireCdn` | DNS CNAME указывает на CDN | `false` |
| `maxLatencyMs` | Порог задержки | `800` |

## Дашборд

Статистика, карта серверов, таблица профилей с задержкой/скоростью/uptime: https://realmec21.github.io/Xer0x-vless-hub/

Дашборд — статический HTML (`docs/index.html`), данные тянутся из `report.json` на raw.githubusercontent.com.

## Запуск локально

Нужен Node.js 18+ (xray-core скачивается автоматически).

```bash
node src/index.js            # полный прогон
node src/index.js --limit 30 # быстрый тест
```

Структура:

```
config.json            — источники, ник, критерии, таймауты
src/index.js           — оркестратор
src/collect.js         — сбор и дедупликация
src/validate.js        — проверка через xray-core + curl
src/speedtest.js       — тест скорости через прокси
src/geo.js             — DNS + ip-api + флаги
src/classify.js        — whitelist/blacklist
src/uptime.js          — трекинг uptime
src/formats.js         — Clash / sing-box экспорт
src/build.js           — переименование и запись подписок
docs/index.html        — веб-дашборд (GitHub Pages)
.github/workflows/     — автообновление раз в сутки
```

## Правила репозитория

- Публикуются только профили, прошедшие реальную проверку подключения.
- **Скоростные значки:** ⚡ <300ms · 🔵 <500ms · 🔴 ≥500ms
- **Uptime:** история хранится в `.cache/history.json`; профили с uptime ≥80% приоритизируются; мёртвые получают 3 прогона на восстановление.
- Каждый прогон перезаписывает все файлы целиком.
- `report.json` — полный отчёт: задержки, скорости, uptime, страны, TLS.

## Автообновление

- **Раз в сутки:** cron `23 3 * * *` (06:23 МСК)
- **Вручную:** Actions → Update subscriptions → Run workflow
- При пустом результате коммит не создаётся, остаются прошлые файлы.

## Дисклеймер

- Профили собираются из публично опубликованных списков; серверы принадлежат третьим лицам. **Трафик через чужой сервер виден его владельцу** — не отправляйте через такие профили пароли, платежи и другую чувствительную данные.
- Работоспособность и легальность использования в вашей юрисдикции не гарантируются.
