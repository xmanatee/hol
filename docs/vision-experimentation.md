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

Ориентация default `object-pose` теперь использует историю **принятых геометрических** affine-измерений, а не сглаженную нормаль отображения. При наблюдаемом возвращении через фронтальное положение знак следующего наклона может задавать уже вычисленная перспективная PnP-поза. Подсказка проходит общую проверку допустимости normal-кандидатов и должна согласовываться с affine-осью наклона в пределах 30°; она не меняет координаты, масштаб или величину наклона. На плоских/гранёных поверхностях локальная плоскость допустима и как исходный prior; для изогнутой или неизвестной формы начальная planar-подсказка не определяет исходный знак: её собственная ветвь тоже может быть неоднозначной. Форма берётся из `ObjectSurfaceModel.surfacePrior`, не из названия representation вроде `photometric-surfels`. Новый выбор, потеря геометрии и descriptor recovery сбрасывают историю; отклонённые кандидаты в неё не попадают. Дополнительных моделей, inference или PnP-вызовов нет.

На цилиндре **без перекрытий**, при штатных 15 Hz CV, максимальная ошибка нормали на видимых кадрах снизилась с **93.95° до 28.38°**, средняя — с 29.05° до 12.37°. Максимальная ошибка вращения head-pose replay снизилась с 106.76° до 31.99°. Средняя/максимальная ошибка координат остались 3.85/9.69 px; лицо видно на тех же 23/29 кадрах. При 30 Hz прежнее качество сохранено: 28.91° максимальной ошибки видимой нормали, 32.74° head-pose error, 2.61/5.73 px координат, 22/29 видимых кадров. Это synthetic geometry replay с идеальными масками, не сертификация устройства или сегментации. Регрессии требуют нормаль ≤30° на **каждом** source frame, head-pose error ≤35°, прежние координаты и не меньше прежнего числа видимых кадров: `node --test src/cv/anchor.objectPose.unit.test.js src/cv/anchor.tracking.unit.test.js src/cv/synthetic/anchorReplayHarness.unit.test.js`.

Это ограниченное исправление перехода, не универсальный цилиндрический 6DoF. [Авторы IPPE](https://github.com/tobycollins/IPPE#resolving-the-flip-ambiguity) прямо описывают неоднозначность почти-affine planar pose и необходимость дополнительной информации; [OpenCV PnP](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html) решает позу по заданным 3D–2D соответствиям, а не восстанавливает неизвестную форму из ничего. После частичного перекрытия цилиндра остаётся около 71° ошибки нормали на отдельных видимых кадрах. Cold-start знак, зеркальные траектории и повторное появление поверхности требуют отдельно проверяемой non-planar геометрии; сглаживание и уверенная плоская PnP сами по себе этого не гарантируют. Для текстурной плоскости без перекрытий максимум ошибки нормали на видимых кадрах остаётся около 16°.

Эксперимент с пересчётом коэффициента фильтра скорости по фактической частоте отклонён: он уменьшал максимальную ошибку плоскости с 27.64 до 18.64 px, но нарушал 13 существующих регрессий и два quality cases. Калибровка cutoff 0.5 Hz также оставляла три регрессии; существующие допуски не ослаблялись. Изменение системное: filtered position участвует в последующих решениях CV/recovery, а не только в отображении. Следующий архитектурный эксперимент — отделить presentation smoothing от геометрического состояния, явно определить временную модель самого estimator и независимо проверить обе границы.

Глянцевый цилиндр (`createGlossyCanSequence`, те же параметры harness) теряет 17/29 кадров даже с идеальной маской, как с частичными перекрытиями, так и без них. В этом cold-anchor replay политика готовности скрывает лицо на всех 29 кадрах; это безопасный отказ, **не** работающее демо. Поэтому следующее блокирующее улучшение — принадлежность и устойчивость landmark-поддержки при движущихся отражениях; сглаживание не восстанавливает потерянную геометрию. Движущийся блик нарушает [предположение LK о постоянстве яркости точки](https://docs.opencv.org/4.12.0/d4/dee/tutorial_optical_flow.html); простая форма банки сама по себе этого не устраняет. Ошибка координат только на сохранившихся кадрах не должна скрывать эти потери. Harness создаёт anchor на первом кадре без предшествующего discovery/preparation и сам не является тестом готовности зелёного выделения.

Для MacBook следует выбирать **одну** поверхность: крышку, экран или участок клавиатуры. Текстурная книжная плоскость не доказывает работу на пустой алюминиевой крышке; открытый ноутбук целиком не является одной плоскостью. Нужны отдельные видео с малотекстурной крышкой/логотипом, бликами на экране, поворотом камеры и рукой перед лицом. Физические iPad Pro M4 и Xiaomi ещё не проверены; desktop WebKit/Chromium не заменяют эту приёмку.

### Ошибка выполнения — не потеря объекта

Недостаток точек, пустой RANSAC consensus и ненаблюдаемая поза остаются обычными отрицательными результатами CV. Исключения LK и homography больше не превращаются в такие результаты: они доходят до общей границы ошибки кадра и остановки anchor worker. Числовые C++ exception pointers bundled OpenCV 4.9 декодируются через `exceptionFromPtr` в `Error` с исходным сообщением; JavaScript errors сохраняются. `finally` освобождает временную homography даже при исключении PnP — [OpenCV.js требует явного удаления native Mat](https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html). Возобновлять тот же WASM runtime после ошибки небезопасно без управления его exception/stack lifecycle; это отдельно описано в [Emscripten](https://emscripten.org/docs/porting/exceptions.html#handling-c-exceptions-from-javascript). Ветки обычного `degraded`/`lost` recovery объединены, но только `lost` требует глобального поиска.

Эксперименты с запретом восстановления старых outliers и удалением unmatched landmarks после descriptor recovery выявили зависимость текущего стека от этих эвристик. Их прямое отключение ухудшило hard risk с 42.85 до 44.40, а отдельное удаление unmatched points нарушило query floor TAP-Vid RGB stacking (AJ 0.200–0.206 при минимуме 0.24). Эти варианты **не включены** и пороги не изменены. Для исправления устаревших наблюдений нужен проверяемый путь повторного наблюдения, а не только более раннее скрытие лица. Принцип проверки соответствий свежим изображением есть в [официальном LK tracking sample OpenCV](https://github.com/opencv/opencv/blob/4.x/samples/python/lk_track.py); [WOFT](https://arxiv.org/abs/2301.10057) исследует отбрасывание неверных flow correspondences, но не интегрирован и не является готовым решением цилиндрического трекинга.

### Стоимость масок и следующие эксперименты

Убраны две повторные операции: смена reference point больше не копирует и не пересчитывает уже проверенный бинарный raster; неизменная проекция переиспользует пиксели между кадрами. Новый `updatedAtFrame` получает отдельный metadata object, поэтому опубликованные старые кадры не мутируют. Изменение позиции, масштаба, поворота или исходной маски по-прежнему требует новой проекции. Это не продлевает tracking evidence и не меняет freshness budget.

Локальное сравнение с `fa3460b`: Node 22.23.3, 960×540, прямоугольная маска 480×260, пять чередующихся batches; по 60 проекций **неизменной позы** и 30 mask refresh на batch. Медиана batch means: projection 0.6224 → 0.00023 ms, mask refresh 1.2250 → 0.6963 ms. До замеров проверены равенство полных масок контрольной версии при разных переносах/масштабах/поворотах и после refresh. Это не browser/device benchmark, не время model inference и не end-to-end ускорение; движущаяся геометрия всё ещё требует resampling. Удалена лишняя factory-обёртка, новые зависимости и backend не добавлялись.

Выделение компоненты использует плоские pixel indices в ограниченной `Uint32Array` вместо очереди объектов координат и четырёх новых соседей на каждый пиксель. Выходной бинарный raster одновременно отмечает уже добавленные точки, поэтому отдельный `visited` buffer не нужен. Сохраняется [стандартная 4-связность flood fill](https://docs.opencv.org/4.12.0/d7/d1b/group__imgproc__misc.html): касание углами не соединяет объекты, строка не заворачивается через край. Каждый пиксель попадает в очередь не более одного раза; её ёмкость ограничена числом пикселей (16 MiB на предельных 4,194,304 px), без рекурсии и дополнительного OpenCV runtime в segmentation worker. Качество модели, пороги и координатная политика не менялись.

Проверки семантики: все 512 бинарных raster 3×3 × 9 seeds сверяются с независимой bitset-реконструкцией; положительные входы включают 1/127/255, дробные координаты seed и неизменность входа. Отдельно проверены 1×1 / 1×257 / 257×1, извилистый однопиксельный путь и полностью связный 2048×2048 raster. Сравнение полной постобработки с `5d0f654` на аналитической confidence grid 512×512, размерах 320×240 / 960×540 / 540×960 и радиусах null/28/160 сохраняет байты маски и все metadata, включая confidence. Новые camera-sized пробы проверяют реальную стоимость стадии, а не переносят время с 320×240 на телефон по предположению.

Приёмка оптимизации: 1071 source tests без ошибок/пропусков, 84/84 quality cases. Hard (28) и cadence (84) сохраняют прежние метрики и regression contracts; их строгие product targets всё ещё не достигнуты в 26 и 63 случаях соответственно. Независимый annotated pack (623 кадра, 18 queries) сохраняет все aggregate metrics, включая AJ 0.17682: точность не улучшена и не объявляется достаточной. Browser suite: 46 pass, 22 явных platform skips при `--workers=1 --trace=off`; четыре camera→readiness→tap→face/animation/error cases проходят в Chromium, WebKit выполняет реальные ImageData model probes, но не этот MediaStream funnel. Это не приёмка физических устройств и не обещание отсутствия latency spikes. Build, lint, форматирование, head/asset/bundle budgets и аудит 127 файлов воронки проходят. Текущие отчёты — `artifacts/segmentation-queue-source-tests.xml`, `artifacts/segmentation-queue-{quality,hard,quick,annotated}.json`.

Проверен и **отклонён** более глубокий эксперимент: учитывать масштаб/поворот, уже содержащиеся в новой сегментации, вместо повторного применения накопленной позы. Контрпример без движения: измеренная маска 640 px становилась 1440 px при сохранённом scale 1.5 и quarter turn. Но один пересчёт базы дал 72/84 quality passes; вариант с полной привязкой к текущей позиции — 73/84 и ухудшение стандартного cylinder replay. Оба варианта полностью удалены, допуски сохранены. Маска участвует в ownership, выборе точек и recovery: исправление координат требует совместного изменения estimator/reference model, а не одной формулы в renderer. Отчёты эксперимента: `artifacts/mask-reference-quality.json`, `artifacts/mask-pose-quality.json`.

Следующий порядок работ по результатам чтения кода и первичных источников:

1. **Задержка и время кадра.** Сейчас `AnchorManager.processFrame` ждёт nested segmentation; FIFO блокирует следующий tracking update и выбор. Двухчастотный pipeline нужен вместе с явным source-frame/reference ownership, проверенной переносимостью маски и отбрасыванием результата после потери непрерывности/reset. Просто убрать `await` небезопасно. Измерять capture-to-response age, queue time и inference отдельно, p50/p95 и false-visible frames. Callback `now` у [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) не является временем экспозиции; `captureTime` не гарантирован у обычного camera video.
2. **Гироскоп как prior, не наблюдение объекта.** Для чистого вращения камеры [OpenCV](https://docs.opencv.org/4.x/d9/dab/tutorial_homography.html) выводит `H = K R K⁻¹`; это подходящая инициализация optical flow, но не модель перемещения предмета, параллакса или окклюзии. [GyroFlow](https://openaccess.thecvf.com/content/ICCV2021/html/Li_GyroFlow_Gyroscope-Guided_Unsupervised_Optical_Flow_Learning_ICCV_2021_paper.html) также разделяет gyro background motion и image motion. Нужны intrinsics, camera↔device basis и временная калибровка. [W3C Device Orientation and Motion](https://www.w3.org/TR/orientation-event/) предоставляет high-level данные, degrees/second и фиксированные device axes, не гарантированный raw IMU; HTTPS и permission/user gesture зависят от API и браузера. Сначала записанные синхронизированные camera/IMU fixtures на iPad/Android; прогноз не должен обновлять свежесть наблюдения или сохранять лицо при потере объекта. Сенсорная интеграция пока не добавлена.
3. **Фотометрия с измеримой пользой.** Сравнить неизменённый grayscale с одним согласованным преобразованием reference/current для low-light, экспозиционных скачков и движущихся бликов. [CLAHE в OpenCV](https://docs.opencv.org/4.x/d2/d74/tutorial_js_histogram_equalization.html) ограничивает усиление контраста, но локальное выравнивание усиливает и шум. Потерянную текстуру насыщенного блика фильтр не восстанавливает. Условие принятия — меньше потерь и pose error без ухудшения отрицательных сцен/реального annotated pack, с учётом стоимости preprocessing; без автоматического переключения неподтверждённых фильтров.

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

### Что уже показал запуск

CPU и Chromium WebGL выделяют положительные analytic fixtures с IoU примерно 0.970–0.997. Они выделяют около 79% foreground на empty-background; эта отрицательная цель **не достигнута**. Point-prompt segmentation не является object detector: уверенная маска фона не доказывает наличие отдельного предмета. Нужна отдельная оценка objectness/discovery на независимых отрицательных видео; запрещать все большие маски одним порогом было бы неверно для крупного предмета у камеры.

Текущий прогон: Apple M4 Max, arm64, Darwin 25.6.0; 800 measured samples (20 × 10 cases × 4 browser/backend combinations) для исходного `5d0f654` и ещё 800 после замены очереди. Browser/backend combinations выполнялись последовательно; native measurements не совмещались с другими нашими тяжёлыми тестами. Латентность ниже — **диапазон медиан по случаям** оптимизированной версии, не среднее из percentile и не скорость физического iPhone.

| Browser / backend            | Ready-mask median range | Positive targets ≥0.85 | Худший positive IoU | False foreground на empty |
| ---------------------------- | ----------------------- | ---------------------- | ------------------- | ------------------------- |
| Chromium CPU/WASM            | 210.5–222.3 ms          | 9/9                    | 0.970               | 79.5%                     |
| Chromium WebGL / SwiftShader | 564.4–664.9 ms          | 9/9                    | 0.971               | 79.1%                     |
| WebKit CPU/WASM              | 207.4–217.7 ms          | 9/9                    | 0.970               | 79.5%                     |
| WebKit WebGL / Apple GPU     | 14.0–26.7 ms            | 6/9                    | 0.072               | 50.2%                     |

Сырые отчёты: `artifacts/segmentation-queue-{before,after}/**/segmentation-report.json`, Chromium 151.0.7922.34 / WebKit 26.5. Все 800 quality observations совпали с контролем, как и RGBA/truth hashes. Native warm CPU/WASM постобработка (не сама модель):

| Browser / raster | Median до → после | p95 до → после   |
| ---------------- | ----------------- | ---------------- |
| Chromium 960×540 | 6.885 → 3.295 ms  | 7.730 → 3.685 ms |
| Chromium 540×960 | 7.015 → 3.260 ms  | 7.905 → 3.505 ms |
| WebKit 960×540   | 5.600 → 2.640 ms  | 5.760 → 2.920 ms |
| WebKit 540×960   | 5.380 → 2.660 ms  | 5.820 → 2.920 ms |

Это примерно двукратное ускорение конкретной стадии. Оно не означает двукратного ускорения pipeline: CPU model inference по-прежнему занимает около 200 ms. У Chromium WebGL короткий API-вызов не включает длительный readback/synchronization; это **SwiftShader**, не аппаратный GPU. Полные round-trip samples сохранены отдельно, чтобы изменение времени model/GPU не приписывалось работе очереди.

На Apple GPU bottle IoU **0.724**, thin-object IoU **0.072** против CPU 0.997 и 0.970; новая native portrait проба тоже выявляет слабое качество, **0.487** против CPU **0.991**. Поэтому GPU не проходит quality policy, даже когда эксперимент корректно завершается; отрицательная цель не достигнута ни одним backend. Расхождение масок воспроизводится в изолированных GPU-прогонах. Изоляция backend tests не доказывает надёжность многократной смены моделей внутри одной сессии. Storage precision f32 не является доказательством одинаковой арифметики delegate; причина расхождения качества пока не установлена.

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
