package at.alpiplan.plugins.widget;

final class WidgetConfig {
    /** Historical and upcoming appointment window for API refresh from the widget. */
    static final int APPOINTMENT_WINDOW_DAYS = 120;
    /** Max appointments stored and shown (chronological). */
    static final int MAX_APPOINTMENTS = 6;
    /** Fixed rows in the widget layout (extra items are omitted). */
    static final int VISIBLE_ROWS = 6;

    private WidgetConfig() {}
}
