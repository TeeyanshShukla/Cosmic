// JXA Mouse Control Script
// Usage: osascript -l JavaScript mouse.js <command> [x] [y]

ObjC.import('CoreGraphics');
ObjC.import('Foundation');

function run(argv) {
    if (argv.length < 1) return;

    const command = argv[0];

    // Helper to generic point
    function makePoint(x, y) {
        return { x: x, y: y };
    }

    // Get current location if needed (for clicking without coords)
    function getCurrentLocation() {
        const event = $.CGEventCreate(null);
        return $.CGEventGetLocation(event);
    }

    if (command === 'move') {
        const x = parseFloat(argv[1]);
        const y = parseFloat(argv[2]);
        const pt = makePoint(x, y);

        const event = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, event);

    } else if (command === 'click') {
        let x, y;

        // If args provided
        if (argv.length >= 3) {
            x = parseFloat(argv[1]);
            y = parseFloat(argv[2]);
            // Move there first to be safe
            const movePt = makePoint(x, y);
            let moveEvt = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, movePt, $.kCGMouseButtonLeft);
            $.CGEventPost($.kCGHIDEventTap, moveEvt);
            $.NSThread.sleepForTimeInterval(0.02); // Small wait
        } else {
            const loc = getCurrentLocation();
            x = loc.x;
            y = loc.y;
        }

        const pt = makePoint(x, y);

        // Down
        const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, pt, $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, down);

        $.NSThread.sleepForTimeInterval(0.02); // 20ms hold

        // Up
        const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, pt, $.kCGMouseButtonLeft);
        $.CGEventPost($.kCGHIDEventTap, up);
    }
}
