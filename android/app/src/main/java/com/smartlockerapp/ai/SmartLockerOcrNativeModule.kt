package com.smartlockerapp.ai

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class SmartLockerOcrNativeModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val DET_MAX_SIDE = 736
        private const val DET_PIXEL_THRESH = 0.20f
        private const val DET_BOX_THRESH = 0.45f
        private const val DET_UNCLIP = 1.40f
        private const val DET_MAX_BOXES = 80

        private const val REC_H = 48
        private const val REC_W = 320

        // TopK-F32 makes recognizer output tiny, so larger batches are safe
        // and greatly reduce session.run overhead.
        private const val REC_BATCH_SIZE = 16

        private const val WORK_MAX_W = 1024
        private const val WORK_MAX_H = 1440

        // Lightweight native auto-deskew for handheld / tilted bill photos.
        // We search only small roll angles; 90/180/270 remain handled by
        // the existing rotation fallback in TypeScript.
        private const val DESKEW_MAX_DEG = 35
        private const val DESKEW_COARSE_STEP = 5
        private const val DESKEW_FINE_RADIUS = 4
        private const val DESKEW_SAMPLE_MAX_SIDE = 448
        private const val DESKEW_DARK_THRESHOLD = 185
        private const val DESKEW_MIN_ABS_DEG = 3f
        private const val DESKEW_MIN_IMPROVEMENT = 1.65

        private const val MODEL_DET =
            "smartlocker/model1_detector.onnx"
        private const val MODEL_REC =
            "smartlocker/model2_recognizer.onnx"
        private const val DICTIONARY =
            "smartlocker/ppocr_keys.txt"

        private const val TOP_VALUES =
            "smartlocker_top2_values"
        private const val TOP_INDICES =
            "smartlocker_top2_indices_f32"
    }

    private data class TextBox(
        val x1: Float,
        val y1: Float,
        val x2: Float,
        val y2: Float,
        val score: Float,
    )

    private data class OcrLine(
        val box: TextBox,
        val text: String,
        val confidence: Float,
    )

    private data class DetectorResult(
        val boxes: List<TextBox>,
        val prepMs: Long,
        val onnxMs: Long,
        val postMs: Long,
    )

    private data class RecognizerResult(
        val lines: List<OcrLine>,
        val prepMs: Long,
        val onnxMs: Long,
        val ctcMs: Long,
        val batches: Int,
    )

    private data class DeskewResult(
        val bitmap: Bitmap,
        val correctionDeg: Float,
        val deskewMs: Long,
        val applied: Boolean,
        val zeroScore: Double,
        val bestScore: Double,
    )

    private val executor =
        Executors.newSingleThreadExecutor()

    private val env: OrtEnvironment =
        OrtEnvironment.getEnvironment()

    @Volatile
    private var detector: OrtSession? = null

    @Volatile
    private var recognizer: OrtSession? = null

    private var detOptions:
            OrtSession.SessionOptions? = null

    private var recOptions:
            OrtSession.SessionOptions? = null

    private var dictionary:
            List<String> = emptyList()

    private var cachedPath:
            String? = null

    private var cachedBitmap:
            Bitmap? = null

    private var cachedDeskewDeg:
            Float = 0f

    private var cachedDeskewMs:
            Long = 0L

    override fun getName(): String =
        "SmartLockerOcrNative"

    @ReactMethod
    fun initialize(
        promise: Promise,
    ) {
        executor.execute {
            try {
                val start =
                    System.nanoTime()

                ensureLoaded()

                val map =
                    Arguments.createMap()

                map.putBoolean(
                    "ok",
                    true,
                )
                map.putInt(
                    "dictionary",
                    dictionary.size,
                )
                map.putInt(
                    "recBatchSize",
                    REC_BATCH_SIZE,
                )
                map.putDouble(
                    "loadMs",
                    elapsedMs(start)
                        .toDouble(),
                )

                promise.resolve(map)
            } catch (
                error: Throwable
            ) {
                promise.reject(
                    "NATIVE_OCR_INIT",
                    error.message,
                    error,
                )
            }
        }
    }

    @ReactMethod
    fun scanOrientation(
        path: String,
        degree: Int,
        promise: Promise,
    ) {
        executor.execute {
            try {
                require(
                    degree == 0 ||
                            degree == 90 ||
                            degree == 180 ||
                            degree == 270,
                ) {
                    "Orientation phải là 0/90/180/270."
                }

                ensureLoaded()

                val totalStart =
                    System.nanoTime()

                val decodeStart =
                    System.nanoTime()

                val base =
                    getCachedBaseBitmap(
                        path,
                    )

                val decodeMs =
                    elapsedMs(
                        decodeStart,
                    )

                val rotateStart =
                    System.nanoTime()

                val work =
                    rotateBitmap(
                        base,
                        degree,
                    )

                val rotateMs =
                    elapsedMs(
                        rotateStart,
                    )

                try {
                    val det =
                        runDetector(work)

                    val rec =
                        runRecognizer(
                            work,
                            det.boxes,
                        )

                    val result =
                        Arguments.createMap()

                    val linesArray =
                        Arguments.createArray()

                    for (
                    line in rec.lines
                    ) {
                        linesArray.pushMap(
                            lineToMap(line),
                        )
                    }

                    result.putArray(
                        "lines",
                        linesArray,
                    )

                    val profile =
                        Arguments.createMap()

                    profile.putInt(
                        "sourceWidth",
                        work.width,
                    )
                    profile.putInt(
                        "sourceHeight",
                        work.height,
                    )
                    profile.putDouble(
                        "deskewDeg",
                        cachedDeskewDeg.toDouble(),
                    )
                    profile.putDouble(
                        "deskewMs",
                        cachedDeskewMs.toDouble(),
                    )
                    profile.putInt(
                        "boxes",
                        det.boxes.size,
                    )
                    profile.putInt(
                        "recBatches",
                        rec.batches,
                    )
                    profile.putDouble(
                        "decodeMs",
                        decodeMs.toDouble(),
                    )
                    profile.putDouble(
                        "rotateMs",
                        rotateMs.toDouble(),
                    )
                    profile.putDouble(
                        "detPrepMs",
                        det.prepMs.toDouble(),
                    )
                    profile.putDouble(
                        "detOnnxMs",
                        det.onnxMs.toDouble(),
                    )
                    profile.putDouble(
                        "detPostMs",
                        det.postMs.toDouble(),
                    )
                    profile.putDouble(
                        "recPrepMs",
                        rec.prepMs.toDouble(),
                    )
                    profile.putDouble(
                        "recOnnxMs",
                        rec.onnxMs.toDouble(),
                    )
                    profile.putDouble(
                        "ctcMs",
                        rec.ctcMs.toDouble(),
                    )
                    profile.putDouble(
                        "totalMs",
                        elapsedMs(
                            totalStart,
                        ).toDouble(),
                    )

                    result.putMap(
                        "profile",
                        profile,
                    )

                    promise.resolve(result)
                } finally {
                    if (
                        work !== base &&
                        !work.isRecycled
                    ) {
                        work.recycle()
                    }
                }
            } catch (
                error: Throwable
            ) {
                promise.reject(
                    "NATIVE_OCR_SCAN",
                    error.message,
                    error,
                )
            }
        }
    }

    @ReactMethod
    fun dispose(
        promise: Promise,
    ) {
        executor.execute {
            try {
                releaseResources()
                promise.resolve(true)
            } catch (
                error: Throwable
            ) {
                promise.reject(
                    "NATIVE_OCR_DISPOSE",
                    error.message,
                    error,
                )
            }
        }
    }

    override fun invalidate() {
        executor.execute {
            releaseResources()
        }

        executor.shutdown()

        super.invalidate()
    }

    @Synchronized
    private fun ensureLoaded() {
        if (
            detector != null &&
            recognizer != null &&
            dictionary.isNotEmpty()
        ) {
            return
        }

        val assets =
            reactApplicationContext.assets

        val detModel =
            assets.open(
                MODEL_DET,
            ).use {
                it.readBytes()
            }

        val recModel =
            assets.open(
                MODEL_REC,
            ).use {
                it.readBytes()
            }

        dictionary =
            assets.open(
                DICTIONARY,
            )
                .bufferedReader(
                    Charsets.UTF_8,
                )
                .useLines {
                        lines ->
                    lines
                        .filter {
                            it.isNotEmpty()
                        }
                        .toList()
                }

        detOptions =
            createCpuOptions(
                threads = 4,
            )

        recOptions =
            createCpuOptions(
                threads = 6,
            )

        detector =
            env.createSession(
                detModel,
                requireNotNull(
                    detOptions,
                ),
            )

        recognizer =
            env.createSession(
                recModel,
                requireNotNull(
                    recOptions,
                ),
            )

        val recOutputs =
            recognizer!!
                .outputNames

        require(
            recOutputs.contains(
                TOP_VALUES,
            ) &&
                    recOutputs.contains(
                        TOP_INDICES,
                    ),
        ) {
            "Model 2 không phải TopK-F32. Outputs=$recOutputs"
        }
    }

    private fun createCpuOptions(
        threads: Int,
    ): OrtSession.SessionOptions {
        val options =
            OrtSession.SessionOptions()

        options.setOptimizationLevel(
            OrtSession.SessionOptions
                .OptLevel.ALL_OPT,
        )

        options.setExecutionMode(
            OrtSession.SessionOptions
                .ExecutionMode.SEQUENTIAL,
        )

        options.setIntraOpNumThreads(
            threads,
        )

        options.setInterOpNumThreads(
            1,
        )

        // Native module no longer has the JSI/XNNPACK crash path.
        // CPU arena helps repeated OCR allocations.
        options.setCPUArenaAllocator(
            true,
        )

        options.setMemoryPatternOptimization(
            false,
        )

        return options
    }

    @Synchronized
    private fun releaseResources() {
        detector?.close()
        recognizer?.close()

        detector = null
        recognizer = null

        detOptions?.close()
        recOptions?.close()

        detOptions = null
        recOptions = null

        cachedBitmap?.let {
            if (!it.isRecycled) {
                it.recycle()
            }
        }

        cachedBitmap = null
        cachedPath = null
        cachedDeskewDeg = 0f
        cachedDeskewMs = 0L
        dictionary = emptyList()
    }

    @Synchronized
    private fun getCachedBaseBitmap(
        rawPath: String,
    ): Bitmap {
        val path =
            normalizePath(
                rawPath,
            )

        if (
            cachedPath == path &&
            cachedBitmap != null &&
            cachedBitmap?.isRecycled == false
        ) {
            return cachedBitmap!!
        }

        cachedBitmap?.let {
            if (!it.isRecycled) {
                it.recycle()
            }
        }

        val decoded =
            decodeSampledBitmap(
                path,
                WORK_MAX_W,
                WORK_MAX_H,
            )

        val upright =
            applyExifOrientation(
                path,
                decoded,
            )

        if (
            upright !== decoded &&
            !decoded.isRecycled
        ) {
            decoded.recycle()
        }

        val scaled =
            scaleContain(
                upright,
                WORK_MAX_W,
                WORK_MAX_H,
            )

        if (
            scaled !== upright &&
            !upright.isRecycled
        ) {
            upright.recycle()
        }

        val deskew =
            autoDeskew(
                scaled,
            )

        if (
            deskew.bitmap !== scaled &&
            !scaled.isRecycled
        ) {
            scaled.recycle()
        }

        cachedPath = path
        cachedBitmap = deskew.bitmap
        cachedDeskewDeg =
            deskew.correctionDeg
        cachedDeskewMs =
            deskew.deskewMs

        return deskew.bitmap
    }

    private fun normalizePath(
        value: String,
    ): String =
        if (
            value.startsWith(
                "file://",
            )
        ) {
            value.substring(7)
        } else {
            value
        }

    private fun decodeSampledBitmap(
        path: String,
        maxW: Int,
        maxH: Int,
    ): Bitmap {
        require(
            File(path).exists(),
        ) {
            "Không tìm thấy ảnh: $path"
        }

        val bounds =
            BitmapFactory.Options().apply {
                inJustDecodeBounds =
                    true
            }

        BitmapFactory.decodeFile(
            path,
            bounds,
        )

        require(
            bounds.outWidth > 0 &&
                    bounds.outHeight > 0,
        ) {
            "Không đọc được kích thước JPEG."
        }

        var sample = 1

        while (
            bounds.outWidth /
            (sample * 2) >=
            maxW ||
            bounds.outHeight /
            (sample * 2) >=
            maxH
        ) {
            sample *= 2
        }

        val options =
            BitmapFactory.Options().apply {
                inSampleSize =
                    sample

                inPreferredConfig =
                    Bitmap.Config.ARGB_8888
            }

        return requireNotNull(
            BitmapFactory.decodeFile(
                path,
                options,
            ),
        ) {
            "BitmapFactory không decode được JPEG."
        }
    }

    private fun applyExifOrientation(
        path: String,
        src: Bitmap,
    ): Bitmap {
        val orientation =
            try {
                ExifInterface(
                    path,
                ).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL,
                )
            } catch (
                _: Throwable
            ) {
                ExifInterface.ORIENTATION_NORMAL
            }

        val matrix =
            Matrix()

        when (
            orientation
        ) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL ->
                matrix.setScale(
                    -1f,
                    1f,
                )

            ExifInterface.ORIENTATION_ROTATE_180 ->
                matrix.setRotate(
                    180f,
                )

            ExifInterface.ORIENTATION_FLIP_VERTICAL ->
                matrix.setScale(
                    1f,
                    -1f,
                )

            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.setRotate(
                    90f,
                )
                matrix.postScale(
                    -1f,
                    1f,
                )
            }

            ExifInterface.ORIENTATION_ROTATE_90 ->
                matrix.setRotate(
                    90f,
                )

            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.setRotate(
                    -90f,
                )
                matrix.postScale(
                    -1f,
                    1f,
                )
            }

            ExifInterface.ORIENTATION_ROTATE_270 ->
                matrix.setRotate(
                    270f,
                )

            else ->
                return src
        }

        return Bitmap.createBitmap(
            src,
            0,
            0,
            src.width,
            src.height,
            matrix,
            true,
        )
    }

    private fun scaleContain(
        src: Bitmap,
        maxW: Int,
        maxH: Int,
    ): Bitmap {
        if (
            src.width <= maxW &&
            src.height <= maxH
        ) {
            return src
        }

        val scale =
            min(
                maxW.toFloat() /
                        src.width,
                maxH.toFloat() /
                        src.height,
            )

        val width =
            max(
                1,
                (
                        src.width *
                                scale
                        ).roundToInt(),
            )

        val height =
            max(
                1,
                (
                        src.height *
                                scale
                        ).roundToInt(),
            )

        return Bitmap.createScaledBitmap(
            src,
            width,
            height,
            true,
        )
    }

    private fun autoDeskew(
        src: Bitmap,
    ): DeskewResult {
        val start =
            System.nanoTime()

        // Work on a small copy so angle search stays cheap.
        val scale =
            min(
                1f,
                DESKEW_SAMPLE_MAX_SIDE.toFloat() /
                        max(
                            src.width,
                            src.height,
                        ),
            )

        val sample =
            if (
                scale >= 0.999f
            ) {
                src
            } else {
                Bitmap.createScaledBitmap(
                    src,
                    max(
                        1,
                        (
                                src.width *
                                        scale
                                ).roundToInt(),
                    ),
                    max(
                        1,
                        (
                                src.height *
                                        scale
                                ).roundToInt(),
                    ),
                    true,
                )
            }

        try {
            val zeroScore =
                projectionSharpness(
                    sample,
                    0f,
                )

            var bestAngle =
                0f

            var bestScore =
                zeroScore

            // Coarse search: -35..35 degrees.
            var angle =
                -DESKEW_MAX_DEG

            while (
                angle <=
                DESKEW_MAX_DEG
            ) {
                if (
                    angle != 0
                ) {
                    val score =
                        projectionSharpness(
                            sample,
                            angle.toFloat(),
                        )

                    if (
                        score >
                        bestScore
                    ) {
                        bestScore =
                            score

                        bestAngle =
                            angle.toFloat()
                    }
                }

                angle +=
                    DESKEW_COARSE_STEP
            }

            // Fine search around the best coarse angle.
            if (
                abs(
                    bestAngle,
                ) >=
                DESKEW_MIN_ABS_DEG
            ) {
                val coarse =
                    bestAngle
                        .roundToInt()

                val from =
                    max(
                        -DESKEW_MAX_DEG,
                        coarse -
                                DESKEW_FINE_RADIUS,
                    )

                val to =
                    min(
                        DESKEW_MAX_DEG,
                        coarse +
                                DESKEW_FINE_RADIUS,
                    )

                for (
                fine in from..to
                ) {
                    if (
                        fine == 0
                    ) {
                        continue
                    }

                    val score =
                        projectionSharpness(
                            sample,
                            fine.toFloat(),
                        )

                    if (
                        score >
                        bestScore
                    ) {
                        bestScore =
                            score

                        bestAngle =
                            fine.toFloat()
                    }
                }
            }

            val improvement =
                if (
                    zeroScore >
                    1e-9
                ) {
                    bestScore /
                            zeroScore
                } else {
                    0.0
                }

            // Conservative gate:
            // only rotate when the horizontal text projection gets
            // substantially sharper than the uncorrected image.
            val shouldApply =
                abs(
                    bestAngle,
                ) >=
                        DESKEW_MIN_ABS_DEG &&
                        improvement >=
                        DESKEW_MIN_IMPROVEMENT

            val corrected =
                if (
                    shouldApply
                ) {
                    rotateBitmapFloat(
                        src,
                        bestAngle,
                    )
                } else {
                    src
                }

            return DeskewResult(
                bitmap = corrected,
                correctionDeg =
                    if (
                        shouldApply
                    ) {
                        bestAngle
                    } else {
                        0f
                    },
                deskewMs =
                    elapsedMs(
                        start,
                    ),
                applied =
                    shouldApply,
                zeroScore =
                    zeroScore,
                bestScore =
                    bestScore,
            )
        } finally {
            if (
                sample !== src &&
                !sample.isRecycled
            ) {
                sample.recycle()
            }
        }
    }

    private fun projectionSharpness(
        src: Bitmap,
        correctionDeg: Float,
    ): Double {
        val rotated =
            if (
                abs(
                    correctionDeg,
                ) <
                0.01f
            ) {
                src
            } else {
                rotateBitmapFloat(
                    src,
                    correctionDeg,
                )
            }

        try {
            val width =
                rotated.width

            val height =
                rotated.height

            if (
                width <= 2 ||
                height <= 2
            ) {
                return 0.0
            }

            val pixels =
                IntArray(
                    width *
                            height,
                )

            rotated.getPixels(
                pixels,
                0,
                width,
                0,
                0,
                width,
                height,
            )

            val rows =
                IntArray(
                    height,
                )

            // Ignore a thin outer border because Bitmap rotation
            // introduces empty triangular regions near the corners.
            val xStart =
                max(
                    0,
                    (
                            width *
                                    0.04f
                            ).roundToInt(),
                )

            val xEnd =
                min(
                    width,
                    (
                            width *
                                    0.96f
                            ).roundToInt(),
                )

            val yStart =
                max(
                    0,
                    (
                            height *
                                    0.04f
                            ).roundToInt(),
                )

            val yEnd =
                min(
                    height,
                    (
                            height *
                                    0.96f
                            ).roundToInt(),
                )

            for (
            y in yStart until
                    yEnd
            ) {
                var dark = 0

                val rowBase =
                    y *
                            width

                for (
                x in xStart until
                        xEnd
                ) {
                    val color =
                        pixels[
                            rowBase +
                                    x
                        ]

                    val r =
                        (
                                color shr 16
                                ) and 0xFF

                    val g =
                        (
                                color shr 8
                                ) and 0xFF

                    val b =
                        color and 0xFF

                    // Fast integer luminance approximation.
                    val luminance =
                        (
                                77 *
                                        r +
                                        150 *
                                        g +
                                        29 *
                                        b
                                ) shr 8

                    if (
                        luminance <
                        DESKEW_DARK_THRESHOLD
                    ) {
                        dark++
                    }
                }

                rows[y] =
                    dark
            }

            var score =
                0.0

            for (
            y in (
                    yStart +
                            1
                    ) until
                    yEnd
            ) {
                val diff =
                    rows[y] -
                            rows[
                                y -
                                        1
                            ]

                score +=
                    diff.toDouble() *
                            diff.toDouble()
            }

            val norm =
                max(
                    1,
                    (
                            xEnd -
                                    xStart
                            ) *
                            max(
                                1,
                                yEnd -
                                        yStart,
                            ),
                )

            return score /
                    norm.toDouble()
        } finally {
            if (
                rotated !== src &&
                !rotated.isRecycled
            ) {
                rotated.recycle()
            }
        }
    }

    private fun rotateBitmapFloat(
        src: Bitmap,
        degree: Float,
    ): Bitmap {
        if (
            abs(
                degree,
            ) <
            0.01f
        ) {
            return src
        }

        val matrix =
            Matrix().apply {
                postRotate(
                    degree,
                )
            }

        return Bitmap.createBitmap(
            src,
            0,
            0,
            src.width,
            src.height,
            matrix,
            true,
        )
    }

    private fun rotateBitmap(
        src: Bitmap,
        degree: Int,
    ): Bitmap {
        if (
            degree == 0
        ) {
            return src
        }

        val matrix =
            Matrix().apply {
                postRotate(
                    degree.toFloat(),
                )
            }

        return Bitmap.createBitmap(
            src,
            0,
            0,
            src.width,
            src.height,
            matrix,
            true,
        )
    }

    private fun round32(
        value: Float,
    ): Int =
        max(
            32,
            (
                    value /
                            32f
                    )
                .roundToInt() *
                    32,
        )

    private fun runDetector(
        raw: Bitmap,
    ): DetectorResult {
        val session =
            requireNotNull(
                detector,
            )

        val prepStart =
            System.nanoTime()

        val scale =
            min(
                1f,
                DET_MAX_SIDE.toFloat() /
                        max(
                            raw.width,
                            raw.height,
                        ),
            )

        val targetW =
            round32(
                raw.width *
                        scale,
            )

        val targetH =
            round32(
                raw.height *
                        scale,
            )

        val scaled =
            if (
                raw.width == targetW &&
                raw.height == targetH
            ) {
                raw
            } else {
                Bitmap.createScaledBitmap(
                    raw,
                    targetW,
                    targetH,
                    true,
                )
            }

        val pixels =
            IntArray(
                targetW *
                        targetH,
            )

        scaled.getPixels(
            pixels,
            0,
            targetW,
            0,
            0,
            targetW,
            targetH,
        )

        val plane =
            targetW *
                    targetH

        val buffer =
            ByteBuffer
                .allocateDirect(
                    3 *
                            plane *
                            4,
                )
                .order(
                    ByteOrder.nativeOrder(),
                )
                .asFloatBuffer()

        for (
        i in pixels.indices
        ) {
            val color =
                pixels[i]

            val r =
                (
                        color shr 16
                        ) and 0xFF

            val g =
                (
                        color shr 8
                        ) and 0xFF

            val b =
                color and 0xFF

            // Same BGR + ImageNet normalization as the validated JS V4.
            buffer.put(
                i,
                (
                        b /
                                255f -
                                0.485f
                        ) /
                        0.229f,
            )

            buffer.put(
                plane + i,
                (
                        g /
                                255f -
                                0.456f
                        ) /
                        0.224f,
            )

            buffer.put(
                plane * 2 + i,
                (
                        r /
                                255f -
                                0.406f
                        ) /
                        0.225f,
            )
        }

        if (
            scaled !== raw &&
            !scaled.isRecycled
        ) {
            scaled.recycle()
        }

        buffer.rewind()

        val prepMs =
            elapsedMs(
                prepStart,
            )

        val inputName =
            session.inputNames.first()

        val onnxStart =
            System.nanoTime()

        val tensor =
            OnnxTensor.createTensor(
                env,
                buffer,
                longArrayOf(
                    1,
                    3,
                    targetH.toLong(),
                    targetW.toLong(),
                ),
            )

        lateinit var probs: FloatArray

        var mapH = 0
        var mapW = 0

        tensor.use {
            session.run(
                mapOf(
                    inputName to tensor,
                ),
            ).use {
                    results ->
                val output =
                    results.get(0)
                            as OnnxTensor

                val info =
                    output.info
                            as TensorInfo

                val shape =
                    info.shape

                require(
                    shape.size == 4,
                ) {
                    "Detector output dims lạ: ${shape.contentToString()}"
                }

                mapH =
                    shape[
                        shape.size - 2
                    ].toInt()

                mapW =
                    shape[
                        shape.size - 1
                    ].toInt()

                val count =
                    mapH *
                            mapW

                val fb =
                    requireNotNull(
                        output.floatBuffer,
                    )

                fb.rewind()

                probs =
                    FloatArray(
                        count,
                    )

                fb.get(
                    probs,
                    0,
                    min(
                        count,
                        fb.remaining(),
                    ),
                )
            }
        }

        val onnxMs =
            elapsedMs(
                onnxStart,
            )

        val postStart =
            System.nanoTime()

        val boxes =
            connectedBoxes(
                probs,
                mapH,
                mapW,
                raw.width,
                raw.height,
            )

        val postMs =
            elapsedMs(
                postStart,
            )

        return DetectorResult(
            boxes,
            prepMs,
            onnxMs,
            postMs,
        )
    }

    private fun connectedBoxes(
        probs: FloatArray,
        mapH: Int,
        mapW: Int,
        rawW: Int,
        rawH: Int,
    ): List<TextBox> {
        val total =
            mapH *
                    mapW

        val visited =
            BooleanArray(
                total,
            )

        val queue =
            IntArray(
                total,
            )

        val components =
            ArrayList<TextBox>()

        val minPixels =
            max(
                6,
                floor(
                    total *
                            0.000015,
                ).toInt(),
            )

        for (
        start in 0 until total
        ) {
            if (
                visited[start] ||
                probs[start] <
                DET_PIXEL_THRESH
            ) {
                continue
            }

            visited[start] =
                true

            var head = 0
            var tail = 1

            queue[0] =
                start

            var minX =
                mapW

            var minY =
                mapH

            var maxX = 0
            var maxY = 0
            var count = 0
            var scoreSum = 0f

            while (
                head < tail
            ) {
                val index =
                    queue[
                        head++
                    ]

                val y =
                    index /
                            mapW

                val x =
                    index -
                            y *
                            mapW

                minX =
                    min(
                        minX,
                        x,
                    )

                minY =
                    min(
                        minY,
                        y,
                    )

                maxX =
                    max(
                        maxX,
                        x,
                    )

                maxY =
                    max(
                        maxY,
                        y,
                    )

                count++
                scoreSum +=
                    probs[index]

                for (
                dy in -1..1
                ) {
                    for (
                    dx in -1..1
                    ) {
                        if (
                            dx == 0 &&
                            dy == 0
                        ) {
                            continue
                        }

                        val nx =
                            x + dx

                        val ny =
                            y + dy

                        if (
                            nx < 0 ||
                            ny < 0 ||
                            nx >= mapW ||
                            ny >= mapH
                        ) {
                            continue
                        }

                        val ni =
                            ny *
                                    mapW +
                                    nx

                        if (
                            visited[ni] ||
                            probs[ni] <
                            DET_PIXEL_THRESH
                        ) {
                            continue
                        }

                        visited[ni] =
                            true

                        queue[
                            tail++
                        ] = ni
                    }
                }
            }

            if (
                count <
                minPixels
            ) {
                continue
            }

            val score =
                scoreSum /
                        max(
                            1,
                            count,
                        )

            if (
                score <
                DET_BOX_THRESH
            ) {
                continue
            }

            var x1 =
                minX.toFloat() /
                        mapW *
                        rawW

            var y1 =
                minY.toFloat() /
                        mapH *
                        rawH

            var x2 =
                (
                        maxX +
                                1
                        ).toFloat() /
                        mapW *
                        rawW

            var y2 =
                (
                        maxY +
                                1
                        ).toFloat() /
                        mapH *
                        rawH

            val bw =
                x2 - x1

            val bh =
                y2 - y1

            if (
                bw < 6f ||
                bh < 5f
            ) {
                continue
            }

            val cx =
                (
                        x1 +
                                x2
                        ) /
                        2f

            val cy =
                (
                        y1 +
                                y2
                        ) /
                        2f

            val ew =
                bw *
                        DET_UNCLIP

            val eh =
                bh *
                        DET_UNCLIP

            x1 =
                clamp(
                    cx -
                            ew /
                            2f,
                    0f,
                    (
                            rawW -
                                    1
                            ).toFloat(),
                )

            y1 =
                clamp(
                    cy -
                            eh /
                            2f,
                    0f,
                    (
                            rawH -
                                    1
                            ).toFloat(),
                )

            x2 =
                clamp(
                    cx +
                            ew /
                            2f,
                    1f,
                    rawW.toFloat(),
                )

            y2 =
                clamp(
                    cy +
                            eh /
                            2f,
                    1f,
                    rawH.toFloat(),
                )

            components.add(
                TextBox(
                    x1,
                    y1,
                    x2,
                    y2,
                    score,
                ),
            )
        }

        return components
            .sortedWith(
                Comparator { a, b ->
                    val ay =
                        (
                                a.y1 +
                                        a.y2
                                ) /
                                2f

                    val by =
                        (
                                b.y1 +
                                        b.y2
                                ) /
                                2f

                    if (
                        kotlin.math.abs(
                            ay - by,
                        ) > 12f
                    ) {
                        ay.compareTo(
                            by,
                        )
                    } else {
                        a.x1.compareTo(
                            b.x1,
                        )
                    }
                },
            )
            .take(
                DET_MAX_BOXES,
            )
    }

    private fun runRecognizer(
        raw: Bitmap,
        boxes: List<TextBox>,
    ): RecognizerResult {
        val session =
            requireNotNull(
                recognizer,
            )

        val inputName =
            session.inputNames.first()

        val lines =
            ArrayList<OcrLine>()

        var prepMs = 0L
        var onnxMs = 0L
        var ctcMs = 0L
        var batches = 0

        var start = 0

        while (
            start <
            boxes.size
        ) {
            val end =
                min(
                    boxes.size,
                    start +
                            REC_BATCH_SIZE,
                )

            val batch =
                boxes.subList(
                    start,
                    end,
                )

            val prepStart =
                System.nanoTime()

            val singleSize =
                3 *
                        REC_H *
                        REC_W

            val buffer =
                ByteBuffer
                    .allocateDirect(
                        batch.size *
                                singleSize *
                                4,
                    )
                    .order(
                        ByteOrder.nativeOrder(),
                    )
                    .asFloatBuffer()

            // Padding after RecResizeImg is zero in normalized space.
            for (
            i in 0 until
                    batch.size *
                    singleSize
            ) {
                buffer.put(
                    i,
                    0f,
                )
            }

            for (
            i in
            batch.indices
            ) {
                writeRecognizerSample(
                    raw,
                    batch[i],
                    buffer,
                    i *
                            singleSize,
                )
            }

            buffer.rewind()

            prepMs +=
                elapsedMs(
                    prepStart,
                )

            val inputTensor =
                OnnxTensor.createTensor(
                    env,
                    buffer,
                    longArrayOf(
                        batch.size
                            .toLong(),
                        3,
                        REC_H.toLong(),
                        REC_W.toLong(),
                    ),
                )

            val onnxStart =
                System.nanoTime()

            inputTensor.use {
                session.run(
                    mapOf(
                        inputName to
                                inputTensor,
                    ),
                ).use {
                        results ->
                    onnxMs +=
                        elapsedMs(
                            onnxStart,
                        )

                    val values =
                        results
                            .get(
                                TOP_VALUES,
                            )
                            .orElseThrow {
                                IllegalStateException(
                                    "Thiếu output $TOP_VALUES",
                                )
                            } as OnnxTensor

                    val indices =
                        results
                            .get(
                                TOP_INDICES,
                            )
                            .orElseThrow {
                                IllegalStateException(
                                    "Thiếu output $TOP_INDICES",
                                )
                            } as OnnxTensor

                    val info =
                        values.info
                                as TensorInfo

                    val dims =
                        info.shape

                    require(
                        dims.size == 3 &&
                                dims[2] == 2L,
                    ) {
                        "TopK output phải [N,T,2], nhận ${dims.contentToString()}"
                    }

                    val timeSteps =
                        dims[1].toInt()

                    val valuesBuffer =
                        requireNotNull(
                            values.floatBuffer,
                        )

                    val indicesBuffer =
                        requireNotNull(
                            indices.floatBuffer,
                        )

                    valuesBuffer.rewind()
                    indicesBuffer.rewind()

                    val decodeStart =
                        System.nanoTime()

                    for (
                    batchIndex in
                    batch.indices
                    ) {
                        val decoded =
                            decodeTopK(
                                valuesBuffer,
                                indicesBuffer,
                                batchIndex,
                                timeSteps,
                            )

                        if (
                            decoded.first
                                .isNotBlank()
                        ) {
                            lines.add(
                                OcrLine(
                                    batch[
                                        batchIndex
                                    ],
                                    decoded.first,
                                    decoded.second,
                                ),
                            )
                        }
                    }

                    ctcMs +=
                        elapsedMs(
                            decodeStart,
                        )
                }
            }

            batches++
            start = end
        }

        return RecognizerResult(
            lines,
            prepMs,
            onnxMs,
            ctcMs,
            batches,
        )
    }

    private fun writeRecognizerSample(
        raw: Bitmap,
        box: TextBox,
        output: java.nio.FloatBuffer,
        baseOffset: Int,
    ) {
        val bw =
            max(
                1f,
                box.x2 -
                        box.x1,
            )

        val bh =
            max(
                1f,
                box.y2 -
                        box.y1,
            )

        val padX =
            bw *
                    0.08f

        val padY =
            bh *
                    0.18f

        val x1 =
            clamp(
                box.x1 -
                        padX,
                0f,
                (
                        raw.width -
                                1
                        ).toFloat(),
            )

        val y1 =
            clamp(
                box.y1 -
                        padY,
                0f,
                (
                        raw.height -
                                1
                        ).toFloat(),
            )

        val x2 =
            clamp(
                box.x2 +
                        padX,
                1f,
                raw.width.toFloat(),
            )

        val y2 =
            clamp(
                box.y2 +
                        padY,
                1f,
                raw.height.toFloat(),
            )

        val left =
            floor(
                x1,
            )
                .toInt()
                .coerceIn(
                    0,
                    raw.width -
                            1,
                )

        val top =
            floor(
                y1,
            )
                .toInt()
                .coerceIn(
                    0,
                    raw.height -
                            1,
                )

        val right =
            ceil(
                x2,
            )
                .toInt()
                .coerceIn(
                    left + 1,
                    raw.width,
                )

        val bottom =
            ceil(
                y2,
            )
                .toInt()
                .coerceIn(
                    top + 1,
                    raw.height,
                )

        val cropW =
            right - left

        val cropH =
            bottom - top

        val ratio =
            cropW.toFloat() /
                    max(
                        1,
                        cropH,
                    )

        val resizedW =
            min(
                REC_W,
                max(
                    1,
                    ceil(
                        REC_H *
                                ratio,
                    ).toInt(),
                ),
            )

        val crop =
            Bitmap.createBitmap(
                raw,
                left,
                top,
                cropW,
                cropH,
            )

        val scaled =
            if (
                crop.width ==
                resizedW &&
                crop.height ==
                REC_H
            ) {
                crop
            } else {
                Bitmap.createScaledBitmap(
                    crop,
                    resizedW,
                    REC_H,
                    true,
                )
            }

        val pixels =
            IntArray(
                resizedW *
                        REC_H,
            )

        scaled.getPixels(
            pixels,
            0,
            resizedW,
            0,
            0,
            resizedW,
            REC_H,
        )

        val plane =
            REC_H *
                    REC_W

        for (
        y in 0 until
                REC_H
        ) {
            for (
            x in 0 until
                    resizedW
            ) {
                val color =
                    pixels[
                        y *
                                resizedW +
                                x
                    ]

                val r =
                    (
                            color shr 16
                            ) and 0xFF

                val g =
                    (
                            color shr 8
                            ) and 0xFF

                val b =
                    color and 0xFF

                val pos =
                    y *
                            REC_W +
                            x

                // Same BGR [-1,1] normalization as validated JS code.
                output.put(
                    baseOffset +
                            pos,
                    b /
                            127.5f -
                            1f,
                )

                output.put(
                    baseOffset +
                            plane +
                            pos,
                    g /
                            127.5f -
                            1f,
                )

                output.put(
                    baseOffset +
                            plane *
                            2 +
                            pos,
                    r /
                            127.5f -
                            1f,
                )
            }
        }

        if (
            scaled !== crop &&
            !scaled.isRecycled
        ) {
            scaled.recycle()
        }

        if (
            !crop.isRecycled
        ) {
            crop.recycle()
        }
    }

    private fun decodeTopK(
        values: java.nio.FloatBuffer,
        indices: java.nio.FloatBuffer,
        batchIndex: Int,
        timeSteps: Int,
    ): Pair<String, Float> {
        val sampleSize =
            timeSteps *
                    2

        val offset =
            batchIndex *
                    sampleSize

        var previous = -1

        val text =
            StringBuilder()

        var confidenceSum = 0f
        var confidenceCount = 0

        for (
        t in 0 until
                timeSteps
        ) {
            val base =
                offset +
                        t *
                        2

            val best =
                values.get(
                    base,
                )

            val second =
                values.get(
                    base + 1,
                )

            val bestIndex =
                indices.get(
                    base,
                )
                    .roundToInt()

            if (
                bestIndex != 0 &&
                bestIndex != previous
            ) {
                val ch =
                    when {
                        bestIndex in
                                1..dictionary.size ->
                            dictionary[
                                bestIndex -
                                        1
                            ]

                        bestIndex ==
                                dictionary.size +
                                1 ->
                            " "

                        else ->
                            null
                    }

                if (
                    ch != null
                ) {
                    text.append(
                        ch,
                    )

                    val margin =
                        1f /
                                (
                                        1f +
                                                kotlin.math.exp(
                                                    -(
                                                            best -
                                                                    second
                                                            ).toDouble(),
                                                )
                                                    .toFloat()
                                        )

                    confidenceSum +=
                        margin

                    confidenceCount++
                }
            }

            previous =
                bestIndex
        }

        val confidence =
            if (
                confidenceCount >
                0
            ) {
                confidenceSum /
                        confidenceCount
            } else {
                0f
            }

        return Pair(
            text.toString(),
            confidence,
        )
    }

    private fun lineToMap(
        line: OcrLine,
    ): WritableMap {
        val map =
            Arguments.createMap()

        map.putDouble(
            "x1",
            line.box.x1
                .toDouble(),
        )
        map.putDouble(
            "y1",
            line.box.y1
                .toDouble(),
        )
        map.putDouble(
            "x2",
            line.box.x2
                .toDouble(),
        )
        map.putDouble(
            "y2",
            line.box.y2
                .toDouble(),
        )
        map.putDouble(
            "score",
            line.box.score
                .toDouble(),
        )
        map.putString(
            "text",
            line.text,
        )
        map.putDouble(
            "confidence",
            line.confidence
                .toDouble(),
        )

        return map
    }

    private fun clamp(
        value: Float,
        minValue: Float,
        maxValue: Float,
    ): Float =
        max(
            minValue,
            min(
                maxValue,
                value,
            ),
        )

    private fun elapsedMs(
        startNs: Long,
    ): Long =
        (
                System.nanoTime() -
                        startNs
                ) /
                1_000_000L
}
