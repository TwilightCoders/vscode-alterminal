/**
 * Indicator Manager
 * 
 * Purpose:
 * - Manage tab indicator states (activity, bell) using bitmasks for efficiency
 * - Provide clean API for showing/hiding indicators with precedence rules
 * - Separate indicator logic from terminal display logic
 * 
 * Responsibilities:
 * - Track indicator states using bitmasks
 * - Enforce indicator precedence (bell > activity)
 * - Update tab UI with appropriate indicators
 * - Clean state management and transitions
 * 
 * Key Features:
 * - Bitmask system for space-efficient state tracking
 * - Precedence system: bell indicator overrides activity
 * - Integration with tab UI updates
 * - Clean transitions between indicator states
 */

export class IndicatorManager {
    constructor(tabId, updateTabUICallback = null) {
        this.tabId = tabId;
        this.updateTabUI = updateTabUICallback;
        
        // Bitmask for indicator states
        this._tabIndicators = 0; // All indicators start disabled
        
        // Indicator bit positions
        this.INDICATORS = {
            ACTIVITY: 1 << 0,  // bit 0 - activity indicator (...)
            BELL: 1 << 1       // bit 1 - bell indicator (🔔) - higher precedence
        };
    }
    
    /**
     * Check if a specific indicator is active
     */
    hasIndicator(indicatorBit) {
        return (this._tabIndicators & indicatorBit) !== 0;
    }
    
    /**
     * Set an indicator bit and update UI
     */
    setIndicator(indicatorBit) {
        this._tabIndicators |= indicatorBit;
        this.updateTabDisplay();
    }
    
    /**
     * Clear an indicator bit and update UI
     */
    clearIndicator(indicatorBit) {
        this._tabIndicators &= ~indicatorBit;
        this.updateTabDisplay();
    }
    
    /**
     * Clear all indicators and update UI
     */
    clearAllIndicators() {
        this._tabIndicators = 0;
        this.updateTabDisplay();
    }
    
    /**
     * Show activity indicator (unless bell is active)
     */
    showActivityIndicator() {
        this.setIndicator(this.INDICATORS.ACTIVITY);
    }
    
    /**
     * Show bell indicator only (overrides activity)
     */
    showBellIndicatorOnly() {
        // Clear activity, set bell
        this.clearIndicator(this.INDICATORS.ACTIVITY);
        this.setIndicator(this.INDICATORS.BELL);
    }
    
    /**
     * Hide activity indicator (keep bell if present)
     */
    hideActivityIndicator() {
        this.clearIndicator(this.INDICATORS.ACTIVITY);
    }
    
    /**
     * Hide bell indicator (activity may still be visible)
     */
    hideBellIndicator() {
        this.clearIndicator(this.INDICATORS.BELL);
    }
    
    /**
     * Get current indicator display text based on precedence
     */
    getIndicatorText() {
        // Bell has precedence over activity
        if (this.hasIndicator(this.INDICATORS.BELL)) {
            return '🔔';
        } else if (this.hasIndicator(this.INDICATORS.ACTIVITY)) {
            return '...';
        }
        return '';
    }
    
    /**
     * Update the tab display with current indicator
     */
    updateTabDisplay() {
        const tabElement = document.querySelector(`[data-tab-id="${this.tabId}"]`);
        if (!tabElement) return;
        
        // Remove any existing indicators
        const existingIndicator = tabElement.querySelector('.tab-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }
        
        // Determine which indicator to show (bell takes precedence)
        let indicatorConfig = null;
        if (this.hasIndicator(this.INDICATORS.BELL)) {
            indicatorConfig = {
                className: 'tab-indicator bell-indicator codicon codicon-bell',
                text: '',
                style: `
                    margin-left: 4px;
                    color: var(--vscode-notificationsWarningIcon-foreground, #ffcc02);
                    font-size: 12px;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                `
            };
        } else if (this.hasIndicator(this.INDICATORS.ACTIVITY)) {
            indicatorConfig = {
                className: 'tab-indicator activity-indicator',
                text: '...',
                style: `
                    margin-left: 4px;
                    color: var(--vscode-tab-unfocusedInactiveForeground, #888);
                    font-size: 11px;
                    opacity: 0;
                    transition: opacity 0.2s ease;
                `
            };
        }
        
        // Create and show the indicator if needed
        if (indicatorConfig) {
            const indicator = document.createElement('span');
            indicator.className = indicatorConfig.className;
            indicator.textContent = indicatorConfig.text;
            indicator.style.cssText = indicatorConfig.style;
            
            // Insert before close button
            const closeBtn = tabElement.querySelector('.tab-close');
            if (closeBtn) {
                tabElement.insertBefore(indicator, closeBtn);
            } else {
                tabElement.appendChild(indicator);
            }
            
            // Trigger animation
            requestAnimationFrame(() => {
                indicator.style.opacity = '1';
            });
        }
    }
    
    /**
     * Get current indicator state (for serialization)
     */
    getState() {
        return {
            indicators: this._tabIndicators
        };
    }
    
    /**
     * Restore indicator state (from deserialization)
     */
    restoreState(state) {
        if (state && typeof state.indicators === 'number') {
            this._tabIndicators = state.indicators;
            this.updateTabDisplay();
        }
    }
}