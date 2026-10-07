#include "cat_face_json.h"

const char kCatFaceJson[] = R"json(
{
  "version": 1,
  "meta": {
    "name": "NianGradient",
    "author": "nian"
  },
  "canvas": {
    "width": 320,
    "height": 240
  },
  "palette": {
    "primary": "#5b6a9a",
    "secondary": "#e89bb8",
    "background": "#f3e8e4"
  },
  "parts": {
    "eyeL": {
      "pos": {
        "x": 228,
        "y": 121
      },
      "shape": "pixel",
      "scale": 2,
      "smooth": true,
      "frames": {
        "open": {
          "w": 20,
          "h": 22,
          "palette": [
            "#5b6a9a",
            "#e89bb8",
            "#9a82b0",
            "#ffffff"
          ],
          "data": "8PDgYbCBkKFwwVDhQOFA4TDxASDxASDxASDxASDxATDhQOFAMWIxUAGiAXCikIKwYvCQ"
        },
        "closed": {
          "w": 20,
          "h": 22,
          "palette": [
            "#5b6a9a"
          ],
          "data": "8PDw8PDw8PDw8PDw8ODhQOHw8PDw8PDw8PDw8FA="
        }
      },
      "upperLid": {
        "angle": 0,
        "cover": 0
      },
      "lowerLid": {
        "angle": 0,
        "cover": 0
      }
    },
    "eyeR": {
      "pos": {
        "x": 92,
        "y": 121
      },
      "shape": "pixel",
      "scale": 2,
      "smooth": true,
      "frames": {
        "open": {
          "w": 20,
          "h": 22,
          "palette": [
            "#5b6a9a",
            "#e89bb8",
            "#9a82b0",
            "#ffffff"
          ],
          "data": "8PDQYbCBkKFwwVDhQOFA4TDxASDxASDxASDxASDxATDhQOFAMWIxUAGiAXCikIKwYvCg"
        },
        "closed": {
          "w": 20,
          "h": 22,
          "palette": [
            "#5b6a9a"
          ],
          "data": "8PDw8PDw8PDw8PDw8ODhQOHw8PDw8PDw8PDw8FA="
        }
      },
      "upperLid": {
        "angle": 0,
        "cover": 0
      },
      "lowerLid": {
        "angle": 0,
        "cover": 0
      }
    },
    "mouth": {
      "pos": {
        "x": 160,
        "y": 169
      },
      "shape": "rect",
      "minWidth": 48,
      "maxWidth": 71,
      "minHeight": 6,
      "maxHeight": 50,
      "color": "#ff52a5",
      "smooth": true
    }
  },
  "animation": {
    "blink": {
      "interval": 4.2,
      "duration": 130
    },
    "saccade": {
      "interval": 2.5,
      "amplitude": 0.45
    },
    "breath": {
      "period": 3.2,
      "depth": 0.55
    }
  },
  "expressions": {
    "angry": {
      "parts": {
        "eyeL": {
          "upperLid": {
            "angle": -24,
            "cover": 0.38
          }
        },
        "eyeR": {
          "upperLid": {
            "angle": 24,
            "cover": 0.38
          }
        }
      }
    },
    "sad": {
      "parts": {
        "eyeL": {
          "upperLid": {
            "angle": 14,
            "cover": 0.32
          }
        },
        "eyeR": {
          "upperLid": {
            "angle": -14,
            "cover": 0.32
          }
        }
      }
    },
    "doubt": {
      "parts": {
        "eyeL": {
          "upperLid": {
            "cover": 0.48
          }
        },
        "eyeR": {
          "upperLid": {
            "cover": 0.06
          }
        },
        "mouth": {
          "minWidth": -12,
          "maxWidth": -7,
          "maxHeight": -10
        }
      }
    },
    "sleepy": {
      "parts": {
        "eyeL": {
          "upperLid": {
            "cover": 0.62
          }
        },
        "eyeR": {
          "upperLid": {
            "cover": 0.62
          }
        }
      },
      "animation": {
        "blink": {
          "interval": 2.4,
          "duration": 270
        },
        "breath": {
          "depth": 0.38
        }
      }
    },
    "happy": {
      "parts": {
        "eyeL": {
          "lowerLid": {
            "cover": 0.45
          }
        },
        "eyeR": {
          "lowerLid": {
            "cover": 0.45
          }
        }
      }
    }
  }
}
)json";
