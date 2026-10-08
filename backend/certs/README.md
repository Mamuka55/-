# Сертификаты НУЦ Минцифры для GigaChat

Цепочка TLS GigaChat (`gigachat.devices.sberbank.ru`, `ngw.devices.sberbank.ru`)
выдана российским НУЦ Минцифры, которого нет в стандартных хранилищах
доверия Node.js — без него запросы падают с
`self-signed certificate in certificate chain`.

В репозитории лежит готовый бандл `russian_trusted_root_ca.pem`
(**Russian Trusted Root CA + Russian Trusted Sub CA**), скачанный с
официальной ссылки документации Сбера:

- https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
- https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt

`AI_CA_CERT` по умолчанию указывает на этот бандл — делать ничего не нужно.
Переопределите путь в `backend/.env`, только если хотите свой файл.

## Обновление бандла

Корневые УЦ живут годами, но при замене НУЦ перезаберите оба файла по
ссылкам выше и склейте в один PEM (порядок: root, затем sub).
Проверка: `openssl x509 -in russian_trusted_root_ca.pem -noout -subject`
должен напечатать `CN=Russian Trusted Root CA`.

## Аварийный режим

`AI_TLS_INSECURE=true` отключает проверку TLS целиком (логируется
предупреждение) — только для проверки связности, не для продакшена.
