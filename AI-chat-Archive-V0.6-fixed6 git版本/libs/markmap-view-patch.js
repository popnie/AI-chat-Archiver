// Patch for markmap-view.js to handle SVGLength errors
(function() {
    'use strict';
    
    // Wait for markmap to be available
    const waitForMarkmap = () => new Promise(resolve => {
        if (window.markmap && window.markmap.Markmap) {
            resolve();
        } else {
            setTimeout(() => waitForMarkmap().then(resolve), 50);
        }
    });
    
    waitForMarkmap().then(() => {
        const originalRelayout = window.markmap.Markmap.prototype._relayout;
        
        window.markmap.Markmap.prototype._relayout = function() {
            if (!this.state.data) return;
            
            // Patch the problematic section
            this.g.selectAll(window.markmap.childSelector(window.markmap.SELECTOR_NODE || 'g.markmap-node'))
                .selectAll(window.markmap.childSelector('foreignObject'))
                .each(function(d) {
                    const el = this.firstChild?.firstChild;
                    
                    if (!el) {
                        d.state.size = d.state.size || [100, 20];
                        return;
                    }
                    
                    try {
                        // Check if element is properly attached and has dimensions
                        if (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0) {
                            const newSize = [
                                el.scrollWidth || el.offsetWidth || 100,
                                el.scrollHeight || el.offsetHeight || 20
                            ];
                            d.state.size = newSize;
                        } else {
                            // Element not properly rendered yet, use fallback
                            d.state.size = d.state.size || [100, 20];
                        }
                    } catch (error) {
                        console.warn('SVG measurement error, using fallback:', error.message);
                        d.state.size = d.state.size || [100, 20];
                    }
                });
            
            // Continue with the rest of the original function
            try {
                originalRelayout.call(this);
            } catch (error) {
                console.warn('Relayout error:', error);
            }
        };
        
        console.log('Markmap SVGLength error patch applied');
    });
})();