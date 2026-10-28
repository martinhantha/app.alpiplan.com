package at.alpiplan.plugins.widget;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.widget.RemoteViews;

/** Adapts fonts and visible rows to the launcher grid size (e.g. 3×2 vs 4×4). */
final class WidgetSizeProfile {
    final int visibleRows;
    final float headerTitleSp;
    final float refreshSp;
    final float emptySp;
    final float timeSp;
    final float rowTitleSp;
    final float buttonSp;
    final int rootPaddingDp;
    final boolean compactLabels;

    private WidgetSizeProfile(
        int visibleRows,
        float headerTitleSp,
        float refreshSp,
        float emptySp,
        float timeSp,
        float rowTitleSp,
        float buttonSp,
        int rootPaddingDp,
        boolean compactLabels) {
        this.visibleRows = visibleRows;
        this.headerTitleSp = headerTitleSp;
        this.refreshSp = refreshSp;
        this.emptySp = emptySp;
        this.timeSp = timeSp;
        this.rowTitleSp = rowTitleSp;
        this.buttonSp = buttonSp;
        this.rootPaddingDp = rootPaddingDp;
        this.compactLabels = compactLabels;
    }

    static WidgetSizeProfile forWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        int widthDp = 250;
        int heightDp = 110;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            Bundle options = manager.getAppWidgetOptions(appWidgetId);
            if (options != null) {
                widthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, widthDp);
                int maxHeightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, -1);
                heightDp =
                    maxHeightDp > 0
                        ? maxHeightDp
                        : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, heightDp);
            }
        }
        return fromDimensions(widthDp, heightDp, textScaleFactor(context));
    }

    /** Matches web root font-size: 15 / 17 / 19 px. */
    static float textScaleFactor(Context context) {
        String scale = WidgetStore.uiScale(context);
        if ("large".equals(scale)) {
            return 19f / 15f;
        }
        if ("medium".equals(scale)) {
            return 17f / 15f;
        }
        return 1f;
    }

    static WidgetSizeProfile fromDimensions(int widthDp, int heightDp, float textScale) {
        WidgetSizeProfile base;
        // 3×2 on One UI ≈ 180×110 dp — one appointment row, smaller type.
        if (heightDp <= 125 || (widthDp <= 200 && heightDp <= 150)) {
            base = new WidgetSizeProfile(1, 12f, 10f, 11f, 9f, 11f, 9f, 6, true);
        } else if (heightDp <= 195 || widthDp <= 220) {
            int rowHeightDp = Math.round(24 * Math.max(1f, textScale));
            int visibleRows = Math.min(WidgetConfig.VISIBLE_ROWS, Math.max(2, (heightDp - 55) / rowHeightDp));
            base = new WidgetSizeProfile(visibleRows, 13f, 10f, 12f, 10f, 12f, 9f, 7, true);
        } else {
            int rowHeightDp = Math.round(27 * Math.max(1f, textScale));
            int visibleRows = Math.min(WidgetConfig.VISIBLE_ROWS, Math.max(3, (heightDp - 80) / rowHeightDp));
            base = new WidgetSizeProfile(visibleRows, 14f, 11f, 13f, 11f, 13f, 10f, 8, false);
        }
        return base.scaled(textScale);
    }

    private WidgetSizeProfile scaled(float textScale) {
        if (textScale <= 1f) {
            return this;
        }
        return new WidgetSizeProfile(
            visibleRows,
            headerTitleSp * textScale,
            refreshSp * textScale,
            emptySp * textScale,
            timeSp * textScale,
            rowTitleSp * textScale,
            buttonSp * textScale,
            Math.round(rootPaddingDp * textScale),
            compactLabels);
    }

    void applyTextSizes(RemoteViews views) {
        setSp(views, R.id.widget_title, headerTitleSp);
        setSp(views, R.id.widget_refresh, refreshSp);
        setSp(views, R.id.widget_empty, emptySp);
        for (WidgetRowIds ids : WidgetRowIds.ROWS) {
            setSp(views, ids.time, timeSp);
            setSp(views, ids.title, rowTitleSp);
            setSp(views, ids.call, buttonSp);
            setSp(views, ids.whatsapp, buttonSp);
            setSp(views, ids.complete, buttonSp + 1.5f);
        }
    }

    void applyRootPadding(Context context, RemoteViews views) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return;
        }
        float density = context.getResources().getDisplayMetrics().density;
        int pad = Math.round(rootPaddingDp * density);
        views.setViewPadding(R.id.widget_root, pad, pad, pad, pad);
    }

    private static void setSp(RemoteViews views, int viewId, float sizeSp) {
        views.setTextViewTextSize(viewId, TypedValue.COMPLEX_UNIT_SP, sizeSp);
    }
}
