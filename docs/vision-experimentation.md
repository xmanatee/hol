# Vision: проверка воронки и честное сравнение подходов

Исследование моделей и backend: 2026-10-16. Это границы имеющихся доказательств, а не заявление о готовности произвольного предмета к надёжному 3D-трекингу.

## Решение

Сохраняем гибрид: редкая сегментация в worker → дешёвое сопровождение принадлежащих объекту точек → проверяемая геометрическая привязка. CPU/WASM остаётся baseline. Доступен альтернативный MediaPipe GPU delegate, **WebGL, не WebGPU**; тот же `InteractiveSegmenterService` выбирает конкретный `backendId`. Неизвестный backend, неверный кадр или ответ другого backend завершаются ошибкой, а не скрытым переключением.

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

## Ограничения, важные для следующих экспериментов

- Уверенная point mask не доказывает наличие отдельного предмета. На пустом фоне текущие delegates дают около 50–79% ложного foreground; нужен независимый objectness/negative-video gate.
- Синтетические сцены с идеальными масками не проверяют discovery. Глянцевый цилиндр теряет геометрию даже с такой маской; движущийся блик нарушает [постоянство яркости LK](https://docs.opencv.org/4.12.0/d4/dee/tutorial_optical_flow.html).
- Полная planar-привязка требует одной согласованной позиции/ориентации PnP и неизменного reference frame. При почти-affine наблюдении остаётся [неоднозначность знака planar pose](https://github.com/tobycollins/IPPE#resolving-the-flip-ambiguity); относительная глубина и normal не устанавливают цилиндрический 6DoF.
- Маска участвует в landmark ownership и recovery, не только в отрисовке. Изолированное исправление scale/rotation базы новой маски регрессировало quality matrix; менять нужно совместно estimator/reference model.
- Сегментация удерживает FIFO-транзакцию. Для асинхронного разделения нужны immutable RGB/mask/source-pose ownership, безопасное применение и отбрасывание устаревших результатов. Просто убрать ожидание нельзя.
- CV-фильтр влияет на последующие решения, а не только на картинку. Пересчёт derivative cutoff по частоте нарушал другие регрессии; presentation smoothing нужно оценивать отдельно от estimator.
- Простое удаление старых outliers или unmatched landmarks ухудшало hard/annotated recovery. Исправление устаревших соответствий требует повторного наблюдения, а не только уменьшения памяти или раннего скрытия лица.
- Cropped ORB, жёсткий feature cap и дескрипторы на LK-точках меняют pyramid/orientation/octave evidence. Translation-invariant keyframe admission безопасен для проверенных плоскостей, но обобщение на изогнутые объекты ухудшало восстановление.
- Для generic-target XFeat важны сохранение исходного learned view и mature view третьего принятого ORB keyframe. Замена первой памяти или более редкий recovery ухудшали per-query floors; геометрии разных views нельзя смешивать.
- Наблюдение и прогноз — разные свидетельства: прогноз, mask-only refresh и гироскоп не продлевают visual freshness. Гироскопический prior требует синхронизации camera/IMU, intrinsics и camera↔device basis; он не моделирует движение предмета и параллакс.
- Runtime exceptions не являются обычной потерей объекта. Native Mat требуют явного освобождения; сбой WASM/model должен достигать общей границы ошибки worker.

## Измерения, определяющие выбор backend

Локальный desktop-прогон: Apple M4 Max, Darwin 25.6.0, Chromium 151.0.7922.34 / WebKit 26.5; 20 samples × 10 probes × 4 browser/backend combinations, последовательно. Это диапазоны медиан ready-mask по случаям, не прогноз скорости физического телефона.

| Browser / backend            | Ready-mask median range | Positive targets ≥0.85 | Худший positive IoU | False foreground на empty |
| ---------------------------- | ----------------------- | ---------------------- | ------------------- | ------------------------- |
| Chromium CPU/WASM            | 210.5–222.3 ms          | 9/9                    | 0.970               | 79.5%                     |
| Chromium WebGL / SwiftShader | 564.4–664.9 ms          | 9/9                    | 0.971               | 79.1%                     |
| WebKit CPU/WASM              | 207.4–217.7 ms          | 9/9                    | 0.970               | 79.5%                     |
| WebKit WebGL / Apple GPU     | 14.0–26.7 ms            | 6/9                    | 0.072               | 50.2%                     |

CPU/WASM остаётся default: Apple GPU быстрее, но нарушает quality policy на тонком объекте и portrait bottle; причина расхождения не установлена. SwiftShader не является аппаратным GPU. Короткий API-вызов не включает GPU synchronization/readback. Сырые измерения сохранены в `artifacts/segmentation-queue-after/**/segmentation-report.json`; воспроизводимый протокол ниже.

## Воспроизводимые эксперименты

```bash
npm run vision:experiments
npm run vision:probes
```

Первая команда строит production и последовательно запускает CPU/WASM и WebGL в Chromium и WebKit. Не запускать параллельно тяжёлые тесты при сравнении времени. Результаты — `artifacts/vision-experiments/**/segmentation-report.json`; trace/video выключены, никакие данные не отправляются во внешние сервисы. HTTP localhost годится только для автоматизированного browser harness; физическая камера iPhone требует HTTPS.

Вторая экспортирует `.rgba`, `.mask` и `manifest.json` в `artifacts/segmentation-probes`. Можно явно указать `npm run vision:probes -- --output=/absolute/path/to/generated-probes`. Это точные входы для native/CoreML/ONNX/C++-эксперимента без повторной реализации генератора. Выходная папка предназначена для генерируемых файлов.

Протокол `hol.point-segmentation.v1`:

- Десять analytic cases: текстурный эллипс, portrait bottle, тонкий объект, слабый свет, блик, независимый похожий distractor, crop у края, фон без целевого предмета и два camera-sized raster — 960×540 / 540×960. Первые восемь входов и их хеши сохранены; новые два отдельно закреплены SHA-256 и включены в native export.
- Для каждого raster: фиксированные SHA-256 RGBA и ground truth; исходные размеры и координаты prompt. Node и браузер независимо сверяют байты; unit-тест фиксирует сами хеши.
- Два warmup и двадцать measured samples на случай; первый sample отдельно отмечен как cold-worker. Это **не** гарантированный cold-network старт: browser/SW/OS caches могут быть тёплыми.
- Сохраняются сырые samples, nearest-rank median/p95/max, IoU/precision/recall и доля ложного foreground. Пустые множества имеют явную семантику; маска должна быть бинарной 0/255.
- `segmentCallMs` — только синхронный вызов API, не обещание завершения GPU. `maskReadbackAndSyncMs` включает ожидание GPU и чтение float mask; `maskPostprocessMs` — connected component/resampling. `totalMs` — worker envelope до отправки CPU-маски; `roundTripMs` добавляет запуск worker/RPC/доставку. `callerCopyMs` хранится отдельно. Не складывать родительский envelope с дочерними этапами.
- Имя backend, frame ID, raster и timing envelopes проверяются. Неуспех не превращается в CPU-результат. Отсутствующий worker WebGL2 явно `unavailable`; прочие ошибки — `failed`.
- Записываются модель/hash/precision, browser/version, признаки окружения и реальный GL renderer, если браузер раскрывает его. Mobile UA/viewport на desktop не считается физическим устройством. Запрошенный delegate не является per-kernel профилем исполнения.

`completed` означает корректно завершённый эксперимент. Это **не** означает, что все quality targets достигнуты. `targetMet` хранится отдельно для каждого случая: IoU ≥0.85 на positives; false foreground ≤1% на empty scene. Эти статичные примеры проверяют sanity и стоимость при разных размерах входа, а не надёжность на real-world видео.

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
