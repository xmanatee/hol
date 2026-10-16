# Vision: проверка воронки и честное сравнение подходов

Проверено 2026-10-16. Это границы имеющихся доказательств, а не заявление о готовности произвольного предмета к надёжному 3D-трекингу.

## Решение

Сохраняем гибрид: редкая сегментация в worker → дешёвое сопровождение принадлежащих объекту точек → проверяемая геометрическая привязка. CPU/WASM остаётся baseline. Добавлен реальный альтернативный MediaPipe GPU delegate, **WebGL, не WebGPU**; тот же `InteractiveSegmenterService` выбирает конкретный `backendId`. Неизвестный backend, неверный кадр или ответ другого backend завершаются ошибкой, а не скрытым переключением.

Следующее исследовательское направление — temporal-memory segmentation, прежде всего EdgeTAM, с SAM 2.1 как качественным reference. Это ещё не интеграции: не добавлены фиктивные адаптеры, не загружены непроверенные веса и не введён второй жизненный цикл объекта.

## Что именно подтверждает каждый уровень

| Уровень            | Существующая проверка                                                                                                | Чего она не доказывает                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Point segmentation | Настоящие MagicTouch CPU/WebGL workers; одинаковые RGBA и независимые бинарные маски                                 | Семантическую «предметность», идентичность во времени, работу на реальном видео         |
| До тапа            | `ObjectObservationSession`: маска, последовательные успешные наблюдения, свежесть, попадание в маску; browser funnel | Обнаружение всех экземпляров в кадре; полный перебор реальных отрицательных сцен        |
| Tracking/recovery  | 84 synthetic quality scenarios, cadence/hard matrix, 18 независимо аннотированных TAP-Vid tracks                     | Что regression floor уже соответствует желаемому продуктовому качеству                  |
| Surface attachment | Независимая проверка проекции полного planar R/t, crop/mirror/ориентации; настоящий GLB в browser funnel             | Metric world pose, неизвестные intrinsics, цилиндрический 6DoF, полную окклюзию объекта |
| Browser/platform   | Chromium и WebKit; emitted workers/assets, camera lifecycle, resize, axe/keyboard/reflow                             | Физический iPhone, тепловую устойчивость, расход батареи и сертифицированные 60 FPS     |

Нельзя подменять метрики: point IoU, VOS J&F, TAP-Vid Average Jaccard и ошибка проекции измеряют разные задачи. Наш real-video pack содержит **точечную** разметку; из неё нельзя получить честный mask IoU.

### Демо: банка и поверхность ноутбука

Проверка стандартного `object-pose`, без семантической подсказки (`targetClassOverride: 'unknown'`), при 15 Hz CV / 30 Hz source. Это процедурные 640×480 сцены с **ground-truth масками**, не съёмка Coca-Cola или MacBook и не проверка discovery. Ошибка ниже — расстояние до известной точки поверхности в исходных пикселях, а не процент успешной сегментации.

| Сцена с движением и частичными перекрытиями | Средняя ошибка | Максимальная ошибка | Потерянные кадры |
| ------------------------------------------- | -------------- | ------------------- | ---------------- |
| Цилиндр с печатью                           | 5.33 px        | 14.22 px            | 0/29             |
| Текстурная плоскость                        | 9.46 px        | 27.64 px            | 0/31             |

В общем [One Euro-style фильтре](https://gery.casiez.net/1euro/) исправлены две ошибки времени: timestamps всегда в миллисекундах, включая интервалы <10 ms и нулевое начало отсчёта. Неверные и идущие назад timestamps явно отвергаются без повреждения состояния. Удалены угадывание единиц, лишние low-pass обёртки и неиспользуемые поля. Проверенная sample-domain фильтрация скорости и все настройки сохранены; на обычном 15/30 Hz replay координаты выше намеренно не изменились.

Повторная проверка выявила ошибку внутри recovery: reinitialization записывала в фильтры более позднее время выполнения `now()`, после чего остальные стадии того же update использовали его исходный timestamp. Теперь reinitialization получает timestamp этой транзакции явно; масочная коррекция использует одно чтение времени для обеих координат. Никакого clamp отрицательного времени или подавления ошибки не добавлено. Регрессия воспроизводит течение времени во время recovery; прежний frozen-clock replay этого не замечал.

Сквозной browser funnel также выявил потерю всех delayed-depth результатов при регулярном обновлении ROI: `updateReferenceRegion` меняет tracking region/shape prior, но не `anchorReference`. Он больше не удаляет immutable source snapshot с собственной RGB/маской/позой/ROI. Новый тест сверяет непустую геометрию после ROI refresh с контрольной доставкой; reset, configure, error и dispose всё ещё отвергают старый источник. Все четыре camera→selection→face/animation→depth browser cases после исправления проходят, как и полный прогон Chromium/WebKit (46 pass, 22 явных platform skips). Тяжёлый discovery screenshot удалён из интервала между ready и tap, чтобы сбор артефактов не провоцировал camera gap и сброс tracking continuity. Сам stale-frame hide/resume тест сохранён; retry и увеличения freshness budget нет.

Проверки воспроизводятся командой `node --test src/cv/oneEuroFilter.unit.test.js src/cv/synthetic/anchorReplayHarness.unit.test.js`. Прежний фильтр не проходит clock-origin и 120 Hz проверки. Новые production-cadence проверки отдельно защищают classless-цилиндр и скрытие лица при потере глянцевого предмета. Они **не** являются приёмкой ориентации: без перекрытий цилиндр имеет максимум около 94° ошибки нормали, хотя максимальная ошибка положения всего 9.69 px. Ошибка присутствует и на видимых кадрах: head-pose replay даёт максимум около 107° ошибки вращения отображаемой головы. Для текстурной плоскости без перекрытий максимум ошибки нормали на видимых кадрах около 16°.

Эксперимент с пересчётом коэффициента фильтра скорости по фактической частоте отклонён: он уменьшал максимальную ошибку плоскости с 27.64 до 18.64 px, но нарушал 13 существующих регрессий и два quality cases. Калибровка cutoff 0.5 Hz также оставляла три регрессии; существующие допуски не ослаблялись. Изменение системное: filtered position участвует в последующих решениях CV/recovery, а не только в отображении. Следующий архитектурный эксперимент — отделить presentation smoothing от геометрического состояния, явно определить временную модель самого estimator и независимо проверить обе границы.

Глянцевый цилиндр (`createGlossyCanSequence`, те же параметры harness) теряет 17/29 кадров даже с идеальной маской, как с частичными перекрытиями, так и без них. В этом cold-anchor replay политика готовности скрывает лицо на всех 29 кадрах; это безопасный отказ, **не** работающее демо. Поэтому следующее блокирующее улучшение — принадлежность и устойчивость landmark-поддержки при движущихся отражениях; сглаживание не восстанавливает потерянную геометрию. Движущийся блик нарушает [предположение LK о постоянстве яркости точки](https://docs.opencv.org/4.12.0/d4/dee/tutorial_optical_flow.html); простая форма банки сама по себе этого не устраняет. Ошибка координат только на сохранившихся кадрах не должна скрывать эти потери. Harness создаёт anchor на первом кадре без предшествующего discovery/preparation и сам не является тестом готовности зелёного выделения.

Для MacBook следует выбирать **одну** поверхность: крышку, экран или участок клавиатуры. Текстурная книжная плоскость не доказывает работу на пустой алюминиевой крышке; открытый ноутбук целиком не является одной плоскостью. Нужны отдельные видео с малотекстурной крышкой/логотипом, бликами на экране, поворотом камеры и рукой перед лицом. Физические iPad Pro M4 и Xiaomi ещё не проверены; desktop WebKit/Chromium не заменяют эту приёмку.

## Воспроизводимые эксперименты

```bash
npm run vision:experiments
npm run vision:probes
```

Первая команда строит production и последовательно запускает CPU/WASM и WebGL в Chromium и WebKit. Не запускать параллельно тяжёлые тесты при сравнении времени. Результаты — `artifacts/vision-experiments/**/segmentation-report.json`; trace/video выключены, никакие данные не отправляются во внешние сервисы. HTTP localhost годится только для автоматизированного browser harness; физическая камера iPhone требует HTTPS.

Вторая экспортирует `.rgba`, `.mask` и `manifest.json` в `artifacts/segmentation-probes`. Можно явно указать `npm run vision:probes -- --output=/absolute/path/to/generated-probes`. Это точные входы для native/CoreML/ONNX/C++-эксперимента без повторной реализации генератора. Выходная папка предназначена для генерируемых файлов.

Протокол `hol.point-segmentation.v1`:

- Восемь analytic cases: текстурный эллипс, portrait bottle, тонкий объект, слабый свет, блик, независимый похожий distractor, crop у края и фон без целевого предмета.
- Для каждого raster: фиксированные SHA-256 RGBA и ground truth; исходные размеры и координаты prompt. Node и браузер независимо сверяют байты; unit-тест фиксирует сами хеши.
- Два warmup и двадцать measured samples на случай; первый sample отдельно отмечен как cold-worker. Это **не** гарантированный cold-network старт: browser/SW/OS caches могут быть тёплыми.
- Сохраняются сырые samples, nearest-rank median/p95/max, IoU/precision/recall и доля ложного foreground. Пустые множества имеют явную семантику; маска должна быть бинарной 0/255.
- `segmentCallMs` — только синхронный вызов API, не обещание завершения GPU. `maskReadbackAndSyncMs` включает ожидание GPU и чтение float mask; `maskPostprocessMs` — connected component/resampling. `totalMs` — worker envelope до отправки CPU-маски; `roundTripMs` добавляет запуск worker/RPC/доставку. `callerCopyMs` хранится отдельно. Не складывать родительский envelope с дочерними этапами.
- Имя backend, frame ID, raster и timing envelopes проверяются. Неуспех не превращается в CPU-результат. Отсутствующий worker WebGL2 явно `unavailable`; прочие ошибки — `failed`.
- Записываются модель/hash/precision, browser/version, признаки окружения и реальный GL renderer, если браузер раскрывает его. Mobile UA/viewport на desktop не считается физическим устройством. Запрошенный delegate не является per-kernel профилем исполнения.

`completed` означает корректно завершённый эксперимент. Это **не** означает, что все quality targets достигнуты. `targetMet` хранится отдельно для каждого случая: IoU ≥0.85 на positives; false foreground ≤1% на empty scene. Эти восемь статичных примеров — sanity suite для сравнения backend, а не новый «сложный real-world benchmark».

### Что уже показал запуск

CPU и Chromium WebGL выделяют положительные analytic fixtures с IoU примерно 0.970–0.997. Они выделяют около 79% foreground на empty-background; эта отрицательная цель **не достигнута**. Point-prompt segmentation не является object detector: уверенная маска фона не доказывает наличие отдельного предмета. Нужна отдельная оценка objectness/discovery на независимых отрицательных видео; запрещать все большие маски одним порогом было бы неверно для крупного предмета у камеры.

Последний отдельный прогон: Apple M4 Max, arm64, Darwin 25.6.0; 640 measured samples (20 × 8 cases × 4 browser/backend combinations), без параллельного тяжёлого тестирования. Латентность ниже — **диапазон медиан по случаям**, не среднее из percentile и не скорость физического iPhone.

| Browser / backend            | Ready-mask median range | Positive targets ≥0.85 | Худший positive IoU | False foreground на empty |
| ---------------------------- | ----------------------- | ---------------------- | ------------------- | ------------------------- |
| Chromium CPU/WASM            | 211.8–214.0 ms          | 7/7                    | 0.970               | 79.5%                     |
| Chromium WebGL / SwiftShader | 659.5–800.1 ms          | 7/7                    | 0.971               | 79.1%                     |
| WebKit CPU/WASM              | 208.7–210.0 ms          | 7/7                    | 0.970               | 79.5%                     |
| WebKit WebGL / Apple GPU     | 15.2–18.8 ms            | 5/7                    | 0.072               | 50.2%                     |

Сырые отчёты: `artifacts/vision-experiments/**/segmentation-report.json`, Chromium 151.0.7922.34 / WebKit 26.5; время завершения 02:50–02:53 UTC. У Chromium WebGL сам API-вызов занимает около 1.4–1.6 ms, но последующий readback/synchronization — 656.8–797.9 ms: «1.6 ms inference» было бы неверным выводом. Это **SwiftShader**, не аппаратный GPU.

На Apple GPU bottle IoU **0.724**, thin-object IoU **0.072** против CPU 0.997 и 0.970. Поэтому GPU не проходит quality policy, даже когда эксперимент корректно завершается; отрицательная цель не достигнута ни одним backend. Расхождение масок воспроизводится в изолированных GPU-прогонах. Изоляция backend tests не доказывает надёжность многократной смены моделей внутри одной сессии. Storage precision f32 не является доказательством одинаковой арифметики delegate; причина расхождения качества пока не установлена.

Полные измерения и renderer находятся в JSON; ни Apple GPU desktop WebKit, ни SwiftShader не прогнозируют Safari на iPhone. CPU default не меняется на основании рекламных FPS или одного быстрого desktop-прогона.

## Модели и библиотеки: статус без смешения протоколов

Исследованы первичные репозитории и лицензии. Только два MagicTouch delegate ниже реально прогнаны в новом локальном mask experiment; остальные модели не выдаются за протестированные в HOL.

| Вариант                    | Для чего нужен                                          | Статус в HOL / препятствие                                                                                                                             |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MagicTouch + MediaPipe     | Point mask                                              | Реальная интеграция, 18,000,426 bytes f32, pinned SHA; CPU/WASM baseline и альтернативный WebGL delegate; без temporal memory                          |
| OpenCV LK + ORB + XFeat    | Межкадровая привязка и recovery                         | Реальная интеграция; OpenCV/WASM, XFeat/ONNX-WASM; не video segmentation model                                                                         |
| Depth Anything V2 Small Q4 | Относительная глубина как вспомогательное свидетельство | Реальная интеграция; план WebGPU+WASM либо WASM. Название плана не доказывает GPU-резидентность всех операций; depth не заменяет идентичность предмета |
| SAM 2.1                    | Качественный baseline video-memory segmentation         | Research only; нет проверенного browser export, state/memory budget и сквозного benchmark                                                              |
| EdgeTAM                    | Приоритетный мобильный temporal candidate               | Research only; CoreML export существует, но нужно проверить весь temporal путь, не только image mask                                                   |
| EfficientTAM               | Альтернативный лёгкий temporal encoder/memory           | Research only; нужны pinned graph/weights, export parity и сравнение на том же hardware                                                                |
| Cutie                      | Object-memory VOS после первой маски                    | Research only; не решает discovery; нужна отдельная проверка конкретных весов и browser/native export                                                  |
| TAPNext++                  | Длительные point tracks и повторное нахождение          | Research only; нет pinned browser graph, temporal-state adapter и локального сравнения с LK/ORB/XFeat                                                  |
| Point2Pose                 | RGB-D 6DoF и онлайн-реконструкция                       | Архитектурный reference; не подключён к браузерному runtime и не эквивалентен относительной monocular depth HOL                                        |
| SAM 3D Objects             | Предположение формы из одного изображения               | Не интегрирован; SAM License вне текущего allowlist, сгенерированная форма не устанавливает наблюдаемую геометрию и идентичность поверхности           |

У [SAM 2.1](https://github.com/facebookresearch/sam2) опубликованы следующие числа: это A100, PyTorch 2.5.1/CUDA 12.4, compiled execution, а не browser measurements.

| SAM 2.1 | Параметры | FPS A100 | SA-V test J&F |
| ------- | --------- | -------- | ------------- |
| Tiny    | 38.9M     | 91.2     | 76.5          |
| Small   | 46M       | 84.8     | 76.6          |
| Base+   | 80.8M     | 64.1     | 78.2          |
| Large   | 224.4M    | 39.5     | 79.5          |

Код и веса SAM 2 — Apache-2.0; bundled third-party компоненты требуют собственной атрибуции. Больше параметров не означает подходящий браузерный бюджет.

Таблицы разных upstream-репозиториев не образуют единый контролируемый leaderboard: совпадение весов, prompts, preprocessing и evaluation recipe не установлено. Для выбора HOL нужны собственные сравнения на одном наборе и hardware; опубликованные результаты здесь только задают кандидатов и ожидаемый порядок затрат.

[EdgeTAM](https://github.com/facebookresearch/EdgeTAM) публикует VOS SA-V test J&F 71.7, DAVIS-2017 val 87.7, MOSE val 70.0; 150.9 FPS A100 с compile и 15.7 FPS iPhone 15 Pro Max. Отдельный image benchmark — 40.4 FPS и 55.5/81.7 mIoU для 1/5 clicks — нельзя называть скоростью video tracking. Код/веса Apache-2.0. Официальный CoreML export создаёт image encoder, prompt encoder и mask decoder; наличие трёх image-модулей не подтверждает экспорт и parity temporal memory. Apple runtime — платформенная зависимость, не полностью open-source browser stack.

[EfficientTAM](https://github.com/yformer/EfficientTAM) лицензирует код/веса Apache-2.0 и содержит benchmark runner. Конкретного сравнимого локального latency/accuracy результата у HOL пока нет. [Cutie](https://github.com/hkchengrex/Cutie) имеет MIT-код и отдельную object-memory модель: начальная маска всё равно нужна, а артефакты весов проверяются до включения в capability manifest.

[TAPNext++](https://github.com/google-deepmind/tapnet) публикует код и checkpoints под Apache-2.0, но это не готовая интеграция его temporal state в Safari. [Point2Pose](https://point2pose.github.io/) заявляет 30 Hz на RTX 4090 с RGB-D; это другой вход и вычислительная платформа. [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects#license) использует SAM License для кода и checkpoints. Ни один из этих вариантов не выдаётся за локально проверенный backend HOL.

### Лицензионные отсечения — не оценка качества модели

- [SAM 3](https://github.com/facebookresearch/sam3/blob/main/LICENSE) использует собственную SAM License, не Apache-2.0. Автоматически включать его в действующую policy нельзя.
- [FoundationPose](https://github.com/NVlabs/FoundationPose/blob/main/LICENSE) ограничивает использование исследовательскими/оценочными некоммерческими целями. Не подходит текущей политике свободного переиспользования HOL.
- [Ultralytics](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) — AGPL-3.0: open-source, но вне текущего allowlist проекта. Это ограничение выбранной политики, а не утверждение «AGPL платная/закрытая».

Ни доступность checkpoint, ни бесплатный demo сами по себе не гарантируют подходящую лицензию кода, весов и датасета.

## Как принимать следующий backend

Не создавать универсальный интерфейс «любая CV-модель». Point-image segmentation, temporal propagation и rigid-pose solving — разные контракты. Текущий point API заменяем через существующую DI-границу manager; temporal adapter обязан дополнительно владеть объектным ID, памятью, временными метками, reset/dispose и пределами ресурсов.

До включения в runtime нужны:

1. Конкретные веса, immutable revision, SHA/bytes, license, input/output layouts, preprocessing, precision и версия runtime. CPU/GPU/native результаты одного семейства не считаются одним артефактом после quantization/export.
2. Тот же pinned probe pack и собственная проверка output parity. Неподдерживаемая операция/устройство — явный результат, не другой незаметно выбранный алгоритм.
3. Независимые mask-video labels для temporal качества: IoU/J&F, identity switch, drift, исчезновение, повторный вход, похожий сосед, рука, вращение, motion blur, прозрачность/блики и смена масштаба. Никакого подсматривания в будущие кадры при online evaluation.
4. End-to-end funnel: время до первого кандидата/green readiness, ложные green events в отрицательных сценах, точный commit ID, loss/hide latency и reacquisition. Валидная маска ещё не валидный face-ready surface.
5. Physical iPhone HTTPS run: warm/cold ready-result latency, memory peak/рост, 5–10 min thermal run, UI frame p95, orientation/background/resume, энергопотребление где измеримо. UI/R3F должен работать параллельно; чистый inference benchmark недостаточен.
6. Только после этого — решение: baseline quality/safety не хуже на каждом владельце контракта; выигрыш соответствует реальному bottleneck, не только среднему FPS. Регрессии отдельных случаев нельзя скрывать агрегатом.

Для ONNX/WebGPU сначала проверить реальную session/inference на устройстве и supported operators. [Документация ORT](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html) описывает CPU↔GPU transfer и GPU tensors/IO binding; именно эти копирования и границы памяти нужно измерять. WebGPU не делает произвольный PyTorch/CoreML checkpoint исполняемым. WASM SIMD/native C++ могут улучшить конкретный kernel, но текущий OpenCV уже WASM: само слово «WASM» не новая оптимизация.

Для независимого native-порта использовать экспортированный pack и сохранять тот же protocol, case/hash/point, model/runtime identity, raw samples и CPU-readable-mask endpoint. Отдельно записывать enqueue, synchronize/readback, cold state, hardware/OS и conversion precision. Нативный bridge не должен передавать полноразмерные RGB/masks через React на каждом кадре.

## Сверка с исходным замыслом

| Требование                   | Реализация и доказательство                                                                                                                                                     | Незакрытая граница                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Подготовка до тапа           | `ObjectObservationSession`; настоящий camera-stream → MagicTouch → LK → green → tap → GLB в `object-funnel.spec.js`                                                             | Нет независимого размеченного negative-video/objectness gate; foreground confidence не означает отдельный предмет                           |
| Постоянный выбранный предмет | Один object ID и карта до/после commit, mask ownership, ORB/XFeat memory, bounded recovery                                                                                      | Не доказано отсутствие identity switch на похожих соседях во всём диапазоне движений                                                        |
| Временная корректность       | FIFO, RGB/mask transaction; depth сопоставляется по capture timestamp с сохранёнными RGB/mask/fit/intrinsics, а не с более поздним кадром; selection/render expiry — 300 ms     | Single-inflight join удерживает один RGB+mask snapshot; влияние на peak memory и temporal quality на физическом iPhone ещё не измерено      |
| Непрерывная маска            | MagicTouch CPU/WASM baseline и сменный WebGL delegate, периодический refresh с настоящим inference                                                                              | Это не temporal-memory VOS; EdgeTAM/EfficientTAM/SAM 2 не подключены                                                                        |
| Физическое крепление         | Полный planar R/t, intrinsics, reference-pixel frame, независимый pinhole oracle для crop/mirror/ориентаций; invalidated reference не выдаётся за старую физическую поверхность | Intrinsics оценены из FOV, не откалиброваны устройством; нет общего material-point 6DoF для цилиндра/бутылки; остальные poses остаются 2.5D |
| Появление и перекрытие       | Planar depth-only contact patch и emergence; истечение наблюдения скрывает лицо, сохраняя выбранный предмет                                                                     | Нет независимой маски руки/полной occlusion geometry; contact patch не равен реконструкции всего предмета                                   |
| Ошибки и ресурсы             | Ошибки OpenCV/model/WASM доходят до UI; discovery останавливается до явного restart; request deadlines, generation ownership, real model/hash/license gates                     | Нужна физическая iPhone-проверка sustained UI+inference, температуры, памяти, camera intrinsics и питания                                   |

Четыре реконструктора разделяют настоящий engine boundary: sparse SfM, parametric surface, direct photometric и depth surfels. Их наличие не доказывает, что все четыре одинаково надёжно решают каждый предмет или передают renderer полную 6DoF-поверхность. Debug-переключатель нужен для сравнений, а не для ручного выбора алгоритма обычным пользователем.

Source-frame depth join проверяется сравнением синхронной и отложенной доставки одной карты: при движении объекта, изменении цвета и повторном использовании mask/RGB buffers карта должна совпадать, а текущая поза продолжать движение. Запоздавший результат после reset, смены reference/calibration или ошибки inference отвергается; потерянный источник не заменяется текущим кадром. [Open3D RGB-D integration](https://www.open3d.org/docs/release/tutorial/pipelines/rgbd_integration.html) также связывает RGB-D наблюдение с позой соответствующего кадра. Это принцип согласования наблюдений, а не утверждение, что относительная глубина HOL стала metric RGB-D или полноценным SLAM.

Физическая planar-привязка публикуется только когда позиция и ориентация принадлежат одной PnP-позе. Если позицию ведёт такая плоскость, её нормаль получает приоритет перед общим reconstruction-surface evidence; отдельная политика выбранной зрелой planar-реконструкции сохраняется. Независимый normal-quality gate по-прежнему обязателен; позиционная пригодность сама по себе не разрешает слабую нормаль. Смешанная 2.5D-поза не выдаётся за физический `surfaceAttachment`.

Selection проверяет конкретный candidate ID и возраст наблюдения при worker commit, не только при отправке тапа. Межконтекстное время переводится через [`performance.timeOrigin`](https://developer.mozilla.org/en-US/docs/Web/API/Performance/timeOrigin). Стандартный перевод не является доказательством корректности после system sleep: браузерные monotonic clocks могут не отсчитывать сон, а точное восстановление межконтекстного времени тогда не гарантируется. Отрицательный возраст отвергается; физическая Safari/iPhone-проверка background/sleep/resume остаётся открытой.

Нативный ARKit/reference-object клиент, MindAR и 8th Wall в HOL не подключены. Это альтернативные платформенные пути, а Earth Speakr — UX-референс, не набор обязательных модулей одного гибрида. Их перечисление в исходном исследовании не является доказательством интеграции или совместимости с текущей лицензионной политикой.

Регрессионная база сохраняет 84/84 per-update quality cases, quick cadence contract, hard loss/distractor/re-entry contract и 623 annotated frames / 18 queries. Но при production-like admission policy **63/84 quick quality targets не достигнуты**, несмотря на точное соблюдение cadence contract. В свежем Node/OpenCV desktop-прогоне средняя длительность admitted update — 18.0 ms, display-amortized cost — 4.7 ms, худший case p95 update — 66.9 ms; это не измерение Safari/iPhone, не доказательство соблюдения CV-бюджета 4 ms и не причинная оценка ускорения от source-frame join. **26/28 hard quality targets не достигнуты**, post-occlusion recovery — 67.5%, annotated AJ — около 0.1768, отдельный false-visible streak — 5.133 s. Успешный regression gate не означает выполнение исходного продуктового обещания.

Следующие блокирующие пакеты работ: независимые objectness/identity video labels; temporal-memory candidate с export parity; единая криволинейная material-point attachment и hand occlusion; приёмка на физическом iPhone, включая память source-frame depth join. Стиль HUD и семантические цвета остаются отдельным UX-долгом, но не заменяют эти проверки корректности.

Свежие результаты сохраняются в `artifacts/source-tests.xml`, browser test output и `artifacts/vision-experiments/**/segmentation-report.json`. Общий `format:check` затрагивает уже существовавший незакоммиченный `pnpm-lock.yaml`; он не изменяется в рамках CV-проверки. Полный `verify:release`, физический iPhone и неизмеренные модели не объявляются проверенными.
