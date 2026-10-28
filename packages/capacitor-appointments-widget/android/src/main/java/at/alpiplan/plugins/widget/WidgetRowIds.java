package at.alpiplan.plugins.widget;

final class WidgetRowIds {
    final int row;
    final int time;
    final int title;
    final int call;
    final int whatsapp;
    final int complete;

    WidgetRowIds(int row, int time, int title, int call, int whatsapp, int complete) {
        this.row = row;
        this.time = time;
        this.title = title;
        this.call = call;
        this.whatsapp = whatsapp;
        this.complete = complete;
    }

    static final WidgetRowIds[] ROWS =
        new WidgetRowIds[] {
            new WidgetRowIds(
                R.id.widget_row_0,
                R.id.item_time_0,
                R.id.item_title_0,
                R.id.item_call_0,
                R.id.item_whatsapp_0,
                R.id.item_complete_0),
            new WidgetRowIds(
                R.id.widget_row_1,
                R.id.item_time_1,
                R.id.item_title_1,
                R.id.item_call_1,
                R.id.item_whatsapp_1,
                R.id.item_complete_1),
            new WidgetRowIds(
                R.id.widget_row_2,
                R.id.item_time_2,
                R.id.item_title_2,
                R.id.item_call_2,
                R.id.item_whatsapp_2,
                R.id.item_complete_2),
            new WidgetRowIds(
                R.id.widget_row_3,
                R.id.item_time_3,
                R.id.item_title_3,
                R.id.item_call_3,
                R.id.item_whatsapp_3,
                R.id.item_complete_3),
            new WidgetRowIds(
                R.id.widget_row_4,
                R.id.item_time_4,
                R.id.item_title_4,
                R.id.item_call_4,
                R.id.item_whatsapp_4,
                R.id.item_complete_4),
            new WidgetRowIds(
                R.id.widget_row_5,
                R.id.item_time_5,
                R.id.item_title_5,
                R.id.item_call_5,
                R.id.item_whatsapp_5,
                R.id.item_complete_5),
        };
}
