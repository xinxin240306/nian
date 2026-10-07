// ParamFace — parametric face renderer for StackChan (ESP-IDF / software canvas).
#pragma once
#include <stdint.h>

#include <M5GFX.h>

namespace paramface {

enum class Expression : uint8_t { Neutral = 0, Happy, Angry, Sad, Doubt, Sleepy };
constexpr int kExpressionCount = 6;
const char* expressionKey(Expression e);

enum class EyeShape : uint8_t { Ellipse, RoundRect, Arc, Pixel };
enum class MouthShape : uint8_t { Rect, Arc, Omega, Pixel };
enum class BrowShape : uint8_t { Rect, Arc, Pixel };

struct SpriteFrame {
    uint16_t w = 0, h = 0;
    uint8_t colors = 0;
    uint16_t palette565[15] = {0};
    uint8_t* pixels = nullptr;
    bool present() const { return pixels != nullptr; }
};

enum class OverlayMode : uint8_t { Inherit, Hidden, Own };

struct PartFrames {
    SpriteFrame f[2];
    bool present() const { return f[0].present() || f[1].present(); }
};

struct SpriteSet {
    PartFrames eyeL[kExpressionCount], eyeR[kExpressionCount];
    PartFrames mouth[kExpressionCount];
    PartFrames browL[kExpressionCount], browR[kExpressionCount];
    SpriteFrame overlay;
    OverlayMode overlayMode[kExpressionCount] = {};
    SpriteFrame overlayExpr[kExpressionCount];
};

void scale2xPass(const uint8_t* src, int w, int h, uint8_t* dst);

struct Lid {
    float angle = 0;
    float cover = 0;
};

struct EyeParams {
    bool present = false;
    float x = 0, y = 0;
    EyeShape shape = EyeShape::Ellipse;
    float width = 32, height = 32;
    float cornerRadius = 0;
    float curve = 0;
    float thickness = 4;
    Lid upperLid, lowerLid;
    bool highlight = false;
    int32_t color = -1;
    float spriteScale = 4;
    bool smooth = false;
};

struct BrowParams {
    bool present = false;
    float x = 0, y = 0;
    BrowShape shape = BrowShape::Rect;
    float width = 40, thickness = 6;
    float angle = 0;
    float curve = 0.5f;
    int32_t color = -1;
    float spriteScale = 4;
    bool smooth = false;
};

struct MouthParams {
    bool present = false;
    float x = 0, y = 0;
    MouthShape shape = MouthShape::Rect;
    float minWidth = 50, maxWidth = 90, minHeight = 4, maxHeight = 60;
    float curve = 0;
    int32_t color = -1;
    float spriteScale = 4;
    bool smooth = false;
};

struct AnimParams {
    float blinkInterval = 4;
    float blinkDuration = 150;
    float saccadeInterval = 3;
    float saccadeAmplitude = 0.4f;
    float breathPeriod = 3.5f;
    float breathDepth = 0.6f;
};

struct PaletteParams {
    int32_t primary = 0xFFFFFF;
    int32_t secondary = 0xFF99CC;
    int32_t background = 0x000000;
};

struct FaceParams {
    float canvasW = 320, canvasH = 240;
    PaletteParams palette;
    EyeParams eyeL, eyeR;
    BrowParams browL, browR;
    MouthParams mouth;
    AnimParams anim;
};

struct DrivenState {
    float eyeOpenL = 1, eyeOpenR = 1;
    float gazeH = 0, gazeV = 0;
    float breath = 0;
    float mouthOpen = 0;
};

class Animator {
 public:
    void reset(uint32_t seed = 0x5EED);
    void tick(float dtMs, const AnimParams& p, DrivenState* out);

 private:
    float rand01();
    uint32_t rng_ = 0x5EED;
    float tMs_ = 0;
    float nextBlinkMs_ = 1000;
    float blinkPhaseMs_ = -1;
    float nextSaccadeMs_ = 500;
    float gazeTargetH_ = 0, gazeTargetV_ = 0;
    float gazeH_ = 0, gazeV_ = 0;
};

class ParamFace {
 public:
    ParamFace() = default;
    ~ParamFace();
    ParamFace(const ParamFace&) = delete;
    ParamFace& operator=(const ParamFace&) = delete;

    bool load(const char* json);
    const char* lastError() const { return error_; }

    void setExpression(Expression e) { expr_ = e; }
    Expression expression() const { return expr_; }
    const FaceParams& effective() const { return faces_[static_cast<int>(expr_)]; }

    void tick(float dtMs);
    void render(M5Canvas* dst);

    void setMouthOpenOverride(bool on, float v = 0) {
        mouthOverride_ = on;
        mouthOverrideV_ = v;
    }
    void setGazeOverride(bool on, float h = 0, float v = 0) {
        gazeOverride_ = on;
        gazeOverrideH_ = h;
        gazeOverrideV_ = v;
    }

    const DrivenState& driven() const { return driven_; }

 private:
    FaceParams faces_[kExpressionCount];
    SpriteSet sprites_;
    bool loaded_ = false;
    Expression expr_ = Expression::Neutral;
    Animator animator_;
    DrivenState driven_;
    bool mouthOverride_ = false;
    float mouthOverrideV_ = 0;
    bool gazeOverride_ = false;
    float gazeOverrideH_ = 0;
    float gazeOverrideV_ = 0;
    char error_[96] = "";
};

}  // namespace paramface
